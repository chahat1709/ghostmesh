// BleTransport — dual-role mesh radio on top of pluggable RadioAdapters.
// Matches bitchat/Services/BLE/BLEService.swift behaviour where the installed
// dependency allows (see src/protocol/radio.ts for exactly what that is):
//  - official service UUID (mainnet F47B…4B5C, testnet …B5A) + characteristic
//    A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D, advertised with NO local name
//  - every device is simultaneously central (scan/connect) and peripheral
//    (advertise/serve) when a peripheral-capable adapter is present
//  - duty-cycled scanning while active (3s on / 1.5s off by default)
//  - RSSI-thresholded connection budget (DEFAULT_LINK_POLICY)
//  - one encoded BitChat packet per GATT write (<=512B MTU); bigger frames go
//    out as type-0x20 fragments and are reassembled here before decode
//
// The whole class is hardware-free: scripts/test-mesh.js drives it with
// LoopbackRadio, so the code paths below are the ones the phone runs.

import nacl from 'tweetnacl';
import { b64encode } from './b64';
import {
  Advertisement,
  BleplxRadio,
  DEFAULT_DUTY,
  DEFAULT_LINK_POLICY,
  LinkPolicy,
  LoopbackRadio,
  NativePeripheralRadio,
  RadioAdapter,
  RadioEvents,
  RadioLink,
  ScanDuty,
  dutyNext,
  rankCandidates,
  shouldConnect,
} from './radio';
import {
  BLE_MTU,
  MsgType,
  decodeFragment,
  decodePacket,
  fragmentPacket,
  hex,
} from './bitchat';

export { BLE_MTU, LoopbackRadio, BleplxRadio, NativePeripheralRadio };
export { DEFAULT_DUTY, DEFAULT_LINK_POLICY };
export type { RadioAdapter, ScanDuty, LinkPolicy };

interface Assembly {
  parts: (Uint8Array | null)[];
  total: number;
  ts: number;
}

const ASSEMBLY_TTL_MS = 60_000;

export interface Timer {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimer: Timer = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Wraps a fragment payload into a signed mesh packet. Supplied by the mesh layer. */
export type WrapFn = (payload: Uint8Array, type: number) => Uint8Array;

export interface BleTransportOptions {
  radios?: RadioAdapter[];
  duty?: ScanDuty;
  policy?: LinkPolicy;
  timer?: Timer;
  now?: () => number;
  /** Fragment wrapper (signs + stamps sender/TTL). Defaults to an unsigned packet. */
  wrap?: WrapFn;
  /** Sender id used by the default fragment wrapper. */
  myPeerId?: Uint8Array;
  testnet?: boolean;
}

export interface TransportStats {
  sent: number;
  fragmentsSent: number;
  received: number;
  reassembled: number;
  dropped: number;
  connectAttempts: number;
}

export class BleTransport {
  available: boolean;
  private radios: RadioAdapter[];
  private duty: ScanDuty;
  private policy: LinkPolicy;
  private timer: Timer;
  private now: () => number;
  private wrap: WrapFn;
  /** Complete decoded-ready frames (single packets or reassembled). */
  onFrame: (frame: Uint8Array) => void = () => {};
  onAdvert: (a: Advertisement) => void = () => {};
  onError: (err: unknown) => void = () => {};
  linkCount = 0;
  stats: TransportStats = {
    sent: 0,
    fragmentsSent: 0,
    received: 0,
    reassembled: 0,
    dropped: 0,
    connectAttempts: 0,
  };

  private links = new Map<string, RadioLink>();
  private candidates = new Map<string, Advertisement>();
  private candidateTs = new Map<string, number>();
  private connecting = new Set<string>();
  private reassembly = new Map<string, Assembly>();
  private scanActive = true;
  private dutyHandle: unknown = null;
  private started = false;
  private central: BleplxRadio | null = null;

  constructor(opts: BleTransportOptions = {}) {
    this.duty = opts.duty ?? DEFAULT_DUTY;
    this.policy = opts.policy ?? DEFAULT_LINK_POLICY;
    this.timer = opts.timer ?? realTimer;
    this.now = opts.now ?? (() => Date.now());
    const myPeerId = opts.myPeerId ?? new Uint8Array(8);
    this.wrap =
      opts.wrap ??
      ((payload, type) => {
        // Unsigned v1 header: ver,type,ttl, ts(8), flags, u16 payload length,
        // then the 8-byte sender id, then the payload. (Offsets 12/13 hold the
        // length — offset 11 is the flags byte.)
        const out = new Uint8Array(14 + 8 + payload.length);
        out[0] = 1;
        out[1] = type & 0xff;
        out[2] = 7; // TTL
        out[11] = 0; // no recipient, no signature
        out[12] = (payload.length >> 8) & 0xff;
        out[13] = payload.length & 0xff;
        out.set(myPeerId, 14);
        out.set(payload, 22);
        return out;
      });
    this.radios =
      opts.radios ?? [
        (this.central = new BleplxRadio({ testnet: opts.testnet })),
        new NativePeripheralRadio({ testnet: opts.testnet }),
      ];
    this.available = this.radios.some((r) => r.canScan || r.canServe);
  }

  /** First reason any adapter refused to run — surfaced to the user. */
  get blockedBy(): string | null {
    for (const r of this.radios) {
      const b = (r as unknown as { blockedBy?: string | null }).blockedBy;
      if (b) return b;
    }
    return null;
  }

  get roles(): { scan: boolean; serve: boolean } {
    return {
      scan: this.radios.some((r) => r.canScan),
      serve: this.radios.some((r) => r.canServe),
    };
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const events: RadioEvents = {
      onAdvertisement: (a) => this.onAdvertisement(a),
      onInbound: (bytes) => this.ingestWrite(bytes),
      onLinkCount: () => this.recountLinks(),
      onError: (err) => this.onError(err),
    };
    for (const r of this.radios) {
      try {
        await r.start(events);
      } catch (err) {
        this.onError(err);
      }
    }
    this.scheduleDuty();
  }

  private recountLinks(): void {
    // central links we opened ourselves + any peripheral-served peer counts
    const served = this.radios.reduce((n, r) => (r.canServe && !r.canScan ? n + r.linkCount() : n), 0);
    this.linkCount = this.links.size + served;
  }

  private onAdvertisement(a: Advertisement): void {
    this.candidates.set(a.id, a);
    this.candidateTs.set(a.id, this.now());
    this.onAdvert(a);
    void this.maybeConnect();
  }

  /** Connection budget: strongest in-range mesh peers first, up to maxLinks. */
  private async maybeConnect(): Promise<void> {
    const ids = [...this.links.keys()];
    for (const cand of rankCandidates([...this.candidates.values()])) {
      if (this.links.size + this.connecting.size >= this.policy.maxLinks) break;
      if (!shouldConnect(cand, ids, this.policy)) continue;
      if (this.connecting.has(cand.id)) continue;
      this.connecting.add(cand.id);
      this.stats.connectAttempts++;
      try {
        const link = await this.openLink(cand);
        if (link) this.links.set(cand.id, link);
      } catch (err) {
        this.onError(err);
      } finally {
        this.connecting.delete(cand.id);
      }
      this.recountLinks();
    }
  }

  private async openLink(cand: Advertisement): Promise<RadioLink | null> {
    for (const r of this.radios) {
      if (!r.canScan) continue;
      const link = await r.connect(cand.id, cand.rssi);
      if (link) return link;
    }
    return null;
  }

  private scheduleDuty(): void {
    const next = dutyNext(this.scanActive, this.duty);
    this.scanActive = next.active;
    this.dutyHandle = this.timer.set(() => {
      this.applyScanState(this.scanActive);
      this.scheduleDuty();
    }, next.ms);
  }

  private applyScanState(on: boolean): void {
    for (const r of this.radios) {
      const settable = r as unknown as { setScanning?: (on: boolean) => Promise<void> };
      if (typeof settable.setScanning === 'function') void settable.setScanning(on);
    }
  }

  /**
   * Split an encoded packet into GATT-write-sized frames. Small packets go
   * out as a single write; larger ones as type-0x20 fragments wrapped via
   * `wrap` (caller stamps sender/TTL/timestamp like any other packet).
   */
  static toWrites(encoded: Uint8Array, wrap: WrapFn, msgId16: Uint8Array): Uint8Array[] {
    if (encoded.length <= BLE_MTU) return [encoded];
    return fragmentPacket(encoded, msgId16).map((frag) => wrap(frag, MsgType.Fragment));
  }

  /** Send one encoded packet out every live link, fragmenting past the MTU. */
  async send(frame: Uint8Array, msgId16?: Uint8Array): Promise<void> {
    const writes =
      frame.length <= BLE_MTU
        ? [frame]
        : BleTransport.toWrites(frame, this.wrap, msgId16 ?? BleTransport.newMsgId());
    if (frame.length > BLE_MTU) this.stats.fragmentsSent += writes.length;
    const targets = this.links.size > 0 ? [...this.links.values()] : this.serveLinks();
    for (const link of targets) {
      for (const w of writes) {
        try {
          await link.write(w);
          this.stats.sent++;
        } catch (err) {
          this.onError(err);
        }
      }
    }
  }

  /** Peripheral side: broadcast to whoever is connected to us. */
  private serveLinks(): RadioLink[] {
    const out: RadioLink[] = [];
    for (const r of this.radios) {
      if (!r.canServe) continue;
      const pending = (r as unknown as { pendingServe?: RadioLink | null }).pendingServe;
      if (pending) out.push(pending);
    }
    return out;
  }

  /** Grab (and cache) the peripheral broadcast link, if this radio can serve. */
  async serveLink(): Promise<RadioLink | null> {
    for (const r of this.radios) {
      if (!r.canServe) continue;
      const holder = r as unknown as { pendingServe?: RadioLink | null };
      if (!holder.pendingServe) holder.pendingServe = await r.connect('*');
      if (holder.pendingServe) return holder.pendingServe;
    }
    return null;
  }

  static newMsgId(rand: (n: number) => Uint8Array = (n) => nacl.randomBytes(n)): Uint8Array {
    return rand(16);
  }

  /** Feed one inbound GATT write/notification. Emits full frames via onFrame. */
  ingestWrite(bytes: Uint8Array): void {
    this.prune();
    const p = decodePacket(bytes);
    if (!p) {
      this.stats.dropped++;
      return; // corrupt / compressed / v2 — ignore per spec guards
    }
    if (p.type !== MsgType.Fragment) {
      this.stats.received++;
      this.onFrame(bytes);
      return;
    }
    const f = decodeFragment(p.payload);
    if (!f || f.total === 0 || f.index >= f.total || f.total > 64) {
      this.stats.dropped++;
      return;
    }
    const key = hex(f.msgId);
    let a = this.reassembly.get(key);
    if (!a || a.total !== f.total) {
      a = { parts: new Array(f.total).fill(null), total: f.total, ts: this.now() };
      this.reassembly.set(key, a);
    }
    a.parts[f.index] = f.chunk;
    if (a.parts.every(Boolean)) {
      this.reassembly.delete(key);
      const total = a.parts.reduce((n, c) => n + (c ? c.length : 0), 0);
      const full = new Uint8Array(total);
      let o = 0;
      for (const c of a.parts) {
        full.set(c!, o);
        o += c!.length;
      }
      if (decodePacket(full)) {
        this.stats.received++;
        this.stats.reassembled++;
        this.onFrame(full);
      } else {
        this.stats.dropped++;
      }
    }
  }

  /** Number of GATT writes a frame of this size would occupy. */
  static writeCount(encodedLength: number): number {
    if (encodedLength <= BLE_MTU) return 1;
    return Math.ceil(encodedLength / (BLE_MTU - 20));
  }

  private prune(now = this.now()): void {
    for (const [k, a] of this.reassembly) {
      if (now - a.ts > ASSEMBLY_TTL_MS) this.reassembly.delete(k);
    }
  }

  /** Drop idle candidates so a peer that walked away stops being connected to. */
  forgetStale(maxAgeMs: number, now = this.now()): number {
    let dropped = 0;
    for (const [id, ts] of [...this.candidateTs.entries()]) {
      if (now - ts > maxAgeMs) {
        this.candidateTs.delete(id);
        this.candidates.delete(id);
        dropped++;
      }
    }
    return dropped;
  }

  connectedIds(): string[] {
    return [...this.links.keys()];
  }

  /** Snapshot of what's on air right now — used by the radar screen. */
  peers(): Advertisement[] {
    return rankCandidates([...this.candidates.values()]);
  }

  /** Debug/introspection helper: base64 of a frame (what actually hits the wire). */
  static wire(frame: Uint8Array): string {
    return b64encode(frame);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.dutyHandle !== null) this.timer.clear(this.dutyHandle);
    this.dutyHandle = null;
    for (const id of [...this.links.keys()]) {
      try {
        this.links.get(id)?.close();
      } catch {}
    }
    this.links.clear();
    for (const r of this.radios) {
      try {
        await r.stop();
      } catch (err) {
        this.onError(err);
      }
    }
    this.linkCount = 0;
  }
}
