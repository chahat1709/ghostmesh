/**
 * MeshSession — the layer on top of the BitChat link layer.
 *
 * This deliberately does NOT own a radio or an engine. The app constructs a
 * `MeshEngine` and wires `engine.transport` to the imported bitchat-android
 * link layer; this session coordinates everything that sits above that:
 *
 *   - Noise XX direct messages (DmSessions) + courier seals for known statics
 *   - chunked file transfer (src/protocol/files.ts)
 *   - store-and-forward outbox that survives a relaunch
 *   - burn messages, tribe passwords, peer liveness, karma reads
 *   - the optional HTTP bridge uplink (src/protocol/bridge.ts)
 *
 * The app keeps its own `engine.onPacket` and calls `ingest()` first; anything
 * this session does not own (announce / public message) falls through to it.
 */
import {
  DmSessions,
  Identity,
  openX,
  sealX,
  signBitPacket,
  verifyBitPacket,
} from '../crypto/ghostCrypto';
import {
  BitPacket,
  encodePacket,
  MsgType,
  NoisePayload,
  originTTL,
} from '../protocol/bitchat';
import { chunkFile as chunkForFile } from '../protocol/files';
import { hex } from '../protocol/bitchat';
import { MeshEngine, RecvStatus } from '../protocol/meshEngine';
import { AssembledFile, FileAssembler } from '../protocol/files';
import { getKv, KvStore } from './persist';
import { BridgeClient } from '../protocol/bridge';

export interface MeshStatus {
  started: boolean;
  dmReady: number;
  outbox: number;
  peerCount: number;
  bridgeOnline: boolean;
  lastError: string | null;
}

export interface MeshHandlers {
  onDm?(peerHex: string, text: string, mine: boolean): void;
  onDmState?(peerHex: string, ready: boolean): void;
  onFile?(file: AssembledFile, fromPeerHex: string): void;
  onStatus?(s: MeshStatus): void;
  onError?(message: string): void;
}

export interface Timers {
  setInterval: (fn: () => void, ms: number) => any;
  clearInterval: (h: any) => void;
}

export interface MeshOptions {
  identity: Identity;
  engine: MeshEngine;
  /** Where frames go. Defaults to `engine.transport`. */
  send?: (frame: Uint8Array) => void;
  handlers?: MeshHandlers;
  kv?: KvStore;
  persist?: boolean;
  sweepEveryMs?: number;
  peerTimeoutMs?: number;
  timers?: Timers;
  now?: () => number;
  bridgeUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Marks a Noise-X courier envelope; XX payloads never start with 0x00. */
export const COURIER_TAG = 0x00;

const K_OUTBOX = 'outbox';
const K_TRIBES = 'tribePasswords';
const K_PEERS = 'peerStatic';

export const DEFAULT_BURN_S = 30;
/** Prefix marking a self-destructing message: `[#burn:30] hello` */
export const BURN_RE = /^\[#burn:(\d{1,5})\]\s*/;

export function parseBurn(text: string): { seconds: number | null; body: string } {
  const m = BURN_RE.exec(text);
  if (!m) return { seconds: null, body: text };
  return { seconds: Math.max(1, parseInt(m[1], 10)), body: text.slice(m[0].length) };
}

export function withBurn(text: string, seconds: number | null): string {
  return seconds && seconds > 0 ? `[#burn:${seconds}] ${text}` : text;
}

export class MeshSession {
  readonly identity: Identity;
  readonly engine: MeshEngine;
  readonly dm: DmSessions;
  readonly files = new FileAssembler();
  bridge: BridgeClient | null = null;

  private handlers: MeshHandlers;
  private sendFrame: (f: Uint8Array) => void;
  private kv: KvStore | null;
  private timers: Timers;
  private now: () => number;
  private peerTimeoutMs: number;
  private sweepEveryMs: number;
  private started = false;
  private tick: any = null;
  /** peerIdHex -> { nick, signPub, staticPub?, lastSeen, rssi, hops } */
  private peers = new Map<string, {
    nick: string;
    signPub: Uint8Array | null;
    staticPub: Uint8Array | null;
    lastSeen: number;
    rssi: number;
    hops: number;
  }>();
  private status: MeshStatus;

  constructor(opts: MeshOptions) {
    this.identity = opts.identity;
    this.engine = opts.engine;
    this.handlers = opts.handlers ?? {};
    this.dm = new DmSessions(opts.identity.staticKey);
    this.kv = opts.persist === false ? null : opts.kv ?? getKv();
    this.timers = opts.timers ?? {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h),
    };
    this.now = opts.now ?? (() => Date.now());
    this.peerTimeoutMs = opts.peerTimeoutMs ?? 90_000;
    this.sweepEveryMs = opts.sweepEveryMs ?? 30_000;
    // engine.send() records our own dedupe key too, so a frame that comes
    // back off the air is never relayed back at the sender.
    this.sendFrame = opts.send ?? ((f) => this.engine.send(f));
    this.status = {
      started: false,
      dmReady: 0,
      outbox: 0,
      peerCount: 0,
      bridgeOnline: false,
      lastError: null,
    };
    if (this.kv) {
      try {
        this.engine.importOutbox(JSON.parse(this.kv.get(K_OUTBOX) ?? '[]'));
      } catch {}
      if (opts.bridgeUrl) this.bridge = new BridgeClient(opts.bridgeUrl, opts.fetchImpl);
    }
  }

  // ------------------------------------------------------------- lifecycle

  /** Replace the callback set. Called by the store binding. */
  setHandlers(handlers: MeshHandlers): void {
    this.handlers = handlers;
    this.publishStatus();
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.status.started = true;
    this.tick = this.timers.setInterval(() => this.housekeep(), this.sweepEveryMs);
    this.publishStatus();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.tick != null) this.timers.clearInterval(this.tick);
    this.tick = null;
    this.status.started = false;
    this.persistOutbox();
    this.publishStatus();
  }

  /** Periodic upkeep: drop stale peers, expire the outbox, forget file parts. */
  housekeep(): void {
    const t = this.now();
    this.engine.sweepOutbox(t);
    this.files.dropStale(5 * 60_000, t);
    for (const [id, p] of this.peers) {
      if (t - p.lastSeen > this.peerTimeoutMs) this.peers.delete(id);
    }
    this.persistOutbox();
    this.publishStatus();
  }

  getStatus(): MeshStatus {
    return {
      ...this.status,
      outbox: this.engine.outbox.length,
      peerCount: this.peers.size,
      dmReady: this.peerCountReady(),
    };
  }

  private peerCountReady(): number {
    let n = 0;
    for (const id of this.peers.keys()) if (this.dm.isReady(id)) n++;
    return n;
  }

  private publishStatus(): void {
    this.status = this.getStatus();
    this.handlers.onStatus?.(this.status);
  }

  fail(message: string): void {
    this.status.lastError = message;
    this.handlers.onError?.(message);
    this.publishStatus();
  }

  clearError(): void {
    this.status.lastError = null;
    this.publishStatus();
  }

  // ------------------------------------------------------------- peer state

  /** Called by the app's announce handler once a peer's signing key is known. */
  learnPeer(
    peerHex: string,
    signPub: Uint8Array | null,
    meta?: { nick?: string; rssi?: number; hops?: number; staticPub?: Uint8Array }
  ): void {
    const prev = this.peers.get(peerHex);
    this.peers.set(peerHex, {
      nick: meta?.nick ?? prev?.nick ?? peerHex.slice(0, 6),
      signPub: signPub ?? prev?.signPub ?? null,
      staticPub: meta?.staticPub ?? prev?.staticPub ?? null,
      lastSeen: this.now(),
      rssi: meta?.rssi ?? prev?.rssi ?? -80,
      hops: meta?.hops ?? prev?.hops ?? 1,
    });
    this.publishStatus();
  }

  peerList(): { peerHex: string; nick: string; rssi: number; hops: number; ready: boolean }[] {
    return [...this.peers.entries()].map(([peerHex, p]) => ({
      peerHex,
      nick: p.nick,
      rssi: p.rssi,
      hops: p.hops,
      ready: this.dm.isReady(peerHex),
    }));
  }

  /** The X25519 static a peer announced — what makes a first-contact DM possible. */
  staticFor(peerHex: string): Uint8Array | null {
    return this.peers.get(peerHex)?.staticPub ?? null;
  }

  karmaFor(peerHex: string): number {
    return this.engine.karmaFor(peerHex);
  }

  // ------------------------------------------------------------- ingest

  /**
   * Offer a packet to this session. Returns true when it was a DM, handshake or
   * file frame (i.e. the app must not render it as a public message).
   */
  ingest(p: BitPacket, _status: RecvStatus, meta?: { linkId: string; rssi: number }): boolean {
    const forMe = !p.recipientId || p.recipientId.every((b, i) => b === this.identity.peerId[i]);
    switch (p.type) {
      case MsgType.NoiseHandshake:
        if (!forMe) return true; // relayed handshake: consume, never display
        this.handleHandshake(p);
        return true;
      case MsgType.NoiseEncrypted:
        if (!forMe) return true;
        this.handleEncrypted(p, hex(p.senderId), meta);
        return true;
      case MsgType.FileTransfer:
        if (!forMe) return true;
        this.handleFile(p, hex(p.senderId));
        return true;
      default:
        return false;
    }
  }

  private handleHandshake(p: BitPacket): void {
    const peerHex = hex(p.senderId);
    let result: { reply: Uint8Array | null; established: boolean };
    try {
      result = this.dm.onHandshakeBytes(peerHex, p.payload);
    } catch (e) {
      this.fail(`handshake failed from ${peerHex.slice(0, 6)}`);
      return;
    }
    if (result.reply) this.signAndSend(MsgType.NoiseHandshake, result.reply, p.senderId);
    if (result.established) this.onSessionReady(peerHex);
  }

  private onSessionReady(peerHex: string): void {
    const prev = this.peers.get(peerHex);
    this.peers.set(peerHex, {
      nick: prev?.nick ?? peerHex.slice(0, 6),
      signPub: prev?.signPub ?? null,
      staticPub: prev?.staticPub ?? null,
      lastSeen: this.now(),
      rssi: prev?.rssi ?? -80,
      hops: prev?.hops ?? 1,
    });
    this.flushFor(peerHex);
    this.handlers.onDmState?.(peerHex, true);
    this.publishStatus();
  }

  private handleEncrypted(p: BitPacket, fromPeerHex: string, meta?: { rssi: number }): void {
    if (meta?.rssi != null) {
      const prev = this.peers.get(fromPeerHex);
      if (prev) this.peers.set(fromPeerHex, { ...prev, rssi: meta.rssi, lastSeen: this.now() });
    }

    // Courier envelope: a Noise-X seal to our static, so it opens without a
    // prior handshake. Distinguished by the 0x00 tag — XX payloads always
    // start with a NoisePayload type byte (>= 0x01).
    if (p.payload.length > 0 && p.payload[0] === COURIER_TAG) {
      const opened = openX(this.identity.staticKey, p.payload.subarray(1));
      if (!opened) {
        this.fail(`could not open courier DM from ${fromPeerHex.slice(0, 6)}`);
        return;
      }
      const prev = this.peers.get(fromPeerHex);
      this.peers.set(fromPeerHex, {
        nick: prev?.nick ?? fromPeerHex.slice(0, 6),
        signPub: prev?.signPub ?? null,
        staticPub: opened.senderPub,
        lastSeen: this.now(),
        rssi: prev?.rssi ?? -80,
        hops: prev?.hops ?? 1,
      });
      const type = opened.plaintext[0];
      if (type === NoisePayload.PrivateMessage) {
        this.handlers.onDm?.(
          fromPeerHex,
          new TextDecoder().decode(opened.plaintext.subarray(1)),
          false
        );
      }
      return;
    }

    let out: { type: number; plaintext: Uint8Array } | null = null;
    try {
      out = this.dm.decryptFrom(fromPeerHex, p.payload);
    } catch {}
    if (!out) {
      this.fail(`could not decrypt DM from ${fromPeerHex.slice(0, 6)}`);
      return;
    }
    if (out.type === NoisePayload.PrivateMessage) {
      this.handlers.onDm?.(fromPeerHex, new TextDecoder().decode(out.plaintext), false);
    }
  }

  private handleFile(p: BitPacket, fromPeerHex: string): void {
    const file = this.files.add(p.payload, this.now());
    if (file) this.handlers.onFile?.(file, fromPeerHex);
  }

  // ------------------------------------------------------------- sending

  /** Build, sign and hand a frame to the link layer. */
  signAndSend(type: number, payload: Uint8Array, recipient?: Uint8Array): Uint8Array {
    const packet: BitPacket = {
      version: 1,
      type,
      ttl: originTTL(this.engine.linkCount),
      timestampMs: this.now(),
      senderId: this.identity.peerId,
      recipientId: recipient,
      payload,
    };
    packet.signature = signBitPacket(packet, this.identity.signPriv);
    const frame = encodePacket(packet);
    this.sendFrame(frame);
    return frame;
  }

  /**
   * Send a DM. If a Noise session is live it goes out encrypted right now;
   * otherwise the plaintext is sealed into the courier outbox and a handshake
   * is started, so the message still lands when the peer is next in range.
   */
  sendDm(peerHex: string, text: string): { queued: boolean; handshaking: boolean; sealed: boolean } {
    const peerId = peerIdBytes(peerHex);
    const plain = new TextEncoder().encode(text);
    const online = peerOnline(this.peers, peerHex, this.peerTimeoutMs, this.now());

    // 1) Live XX session — cheapest and forward-secret.
    if (this.dm.isReady(peerHex)) {
      const sealed = this.dm.encryptTo(peerHex, NoisePayload.PrivateMessage, plain);
      if (sealed) {
        this.deliverOrQueue(MsgType.NoiseEncrypted, sealed, peerId, online);
        this.handlers.onDm?.(peerHex, text, true);
        this.publishStatus();
        return { queued: !online, handshaking: false, sealed: true };
      }
    }

    // 2) No session, but the peer announced their X25519 static: seal with
    //    Noise-X so the message is readable even before any handshake.
    const theirStatic = this.staticFor(peerHex);
    if (theirStatic) {
      const inner = new Uint8Array(1 + plain.length);
      inner[0] = NoisePayload.PrivateMessage;
      inner.set(plain, 1);
      const env = sealX(this.identity.staticKey, theirStatic, inner);
      const tagged = new Uint8Array(1 + env.length);
      tagged[0] = COURIER_TAG;
      tagged.set(env, 1);
      this.deliverOrQueue(MsgType.NoiseEncrypted, tagged, peerId, online);
      this.handlers.onDm?.(peerHex, text, true);
      if (!this.dm.isReady(peerHex)) this.startHandshake(peerHex, !online);
      this.publishStatus();
      return { queued: !online, handshaking: false, sealed: true };
    }

    // 3) Nothing known about the peer yet: only the handshake can go out.
    this.startHandshake(peerHex, !online);
    this.publishStatus();
    return { queued: true, handshaking: true, sealed: false };
  }

  /** Send now if the peer is in range, otherwise hold it in the courier outbox. */
  private deliverOrQueue(type: number, payload: Uint8Array, peerId: Uint8Array, online: boolean): void {
    const frame = this.buildFrame(type, payload, peerId);
    if (online) this.sendFrame(frame);
    else this.engine.queueForLater(frame);
    this.persistOutbox();
  }

  /** Send (or queue) the first XX message (e →) to a peer. */
  startHandshake(peerHex: string, queue = false): void {
    let msg: Uint8Array;
    try {
      msg = this.dm.beginHandshake(peerHex);
    } catch (e) {
      this.fail(`cannot start handshake with ${peerHex.slice(0, 6)}`);
      return;
    }
    const peerId = peerIdBytes(peerHex);
    if (queue) {
      this.engine.queueForLater(this.buildFrame(MsgType.NoiseHandshake, msg, peerId));
      // Without this the held handshake would not survive a relaunch.
      this.persistOutbox();
    } else {
      this.signAndSend(MsgType.NoiseHandshake, msg, peerId);
    }
    this.handlers.onDmState?.(peerHex, false);
  }

  /** Send a whole file, chunked. Returns the number of frames written. */
  sendFile(peerHex: string, name: string, bytes: Uint8Array): number {
    const peerId = peerIdBytes(peerHex);
    const chunks = chunkForFile(name, bytes);
    for (const c of chunks) {
      if (peerOnline(this.peers, peerHex, this.peerTimeoutMs, this.now())) {
        this.signAndSend(MsgType.FileTransfer, c, peerId);
      } else {
        const frame = this.buildFrame(MsgType.FileTransfer, c, peerId);
        this.engine.queueForLater(frame);
      }
    }
    this.persistOutbox();
    return chunks.length;
  }

  private buildFrame(type: number, payload: Uint8Array, recipient: Uint8Array): Uint8Array {
    const packet: BitPacket = {
      version: 1,
      type,
      ttl: originTTL(this.engine.linkCount),
      timestampMs: this.now(),
      senderId: this.identity.peerId,
      recipientId: recipient,
      payload,
    };
    packet.signature = signBitPacket(packet, this.identity.signPriv);
    return encodePacket(packet);
  }

  /** Push anything queued for a peer that just came online. */
  flushFor(peerHex: string): number {
    const due = this.engine.flushForPeer(peerIdBytes(peerHex));
    for (const f of due) this.sendFrame(f);
    if (due.length) this.persistOutbox();
    return due.length;
  }

  exportOutbox(): string[] {
    return this.engine.exportOutbox();
  }

  importOutbox(frames: string[]): void {
    this.engine.importOutbox(frames);
    this.persistOutbox();
  }

  // ------------------------------------------------------------- tribes

  getTribePasswords(): Record<string, string> {
    if (!this.kv) return {};
    try {
      return JSON.parse(this.kv.get(K_TRIBES) ?? '{}');
    } catch {
      return {};
    }
  }

  setTribePassword(tribe: string, password: string): void {
    if (!this.kv) return;
    const all = this.getTribePasswords();
    all[tribe] = password;
    this.kv.set(K_TRIBES, JSON.stringify(all));
  }

  forgetTribePassword(tribe: string): void {
    if (!this.kv) return;
    const all = this.getTribePasswords();
    delete all[tribe];
    this.kv.set(K_TRIBES, JSON.stringify(all));
  }

  // ------------------------------------------------------------- persistence

  private persistOutbox(): void {
    if (!this.kv) return;
    try {
      this.kv.set(K_OUTBOX, JSON.stringify(this.engine.exportOutbox()));
    } catch {}
  }

  /** Wipe every key this app owns (panic button). */
  wipe(): void {
    this.engine.outbox.length = 0;
    this.files.clear();
    this.peers.clear();
    this.kv?.clearAll();
    this.publishStatus();
  }
}

// ----------------------------------------------------------------- helpers

function peerIdBytes(peerHex: string): Uint8Array {
  const clean = peerHex.replace(/[^0-9a-f]/gi, '');
  if (clean.length !== 16) throw new Error('peer id must be 16 hex chars');
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function peerOnline(
  peers: Map<string, { lastSeen: number }>,
  peerHex: string,
  timeoutMs: number,
  now: number
): boolean {
  const p = peers.get(peerHex);
  return !!p && now - p.lastSeen <= timeoutMs;
}

/** Re-export so the app can verify announces it renders. */
export { verifyBitPacket };
