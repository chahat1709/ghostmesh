// Radio adapters — the physical layer under BleTransport.
//
// IMPORTANT, verified against the dependency actually installed
// (react-native-ble-plx@3.5.1): that library is CENTRAL-ONLY. There is no
// `startAdvertising` and no GATT server in its JS, its typings or its native
// code (grep for `advertis` only finds scan-side parsing + the
// `AlreadyAdvertising` error code). So the peripheral half of the BitChat
// dual-role radio cannot come from ble-plx:
//
//   * BleplxRadio           — central role, real ble-plx APIs (scan / connect /
//                             MTU / discover / monitor / write). Fully usable.
//   * NativePeripheralRadio — peripheral role (advertise + GATT server) via the
//                             small native module `GhostMeshRadio` shipped in
//                             android/app/src/main/java/com/ghostmesh/app/radio/.
//                             Loads only when that module is present; otherwise
//                             `canServe` stays false and the mesh degrades to
//                             central-only.
//   * LoopbackRadio         — in-process radio pair, used by scripts/test-mesh.js
//                             to exercise the whole transport with no hardware.
//
// Everything here is transport-agnostic: BleTransport only ever sees a
// RadioAdapter, so the simulator and the tests drive the identical code path
// the phone does.

import { b64decode, b64encode } from './b64';
import { BLE_MTU, CHAR_UUID, SERVICE_UUID_MAINNET, SERVICE_UUID_TESTNET } from './bitchat';

export interface Advertisement {
  id: string;
  rssi: number;
  /** true when the advertisement carried our mesh service UUID. */
  mesh: boolean;
}

export interface RadioLink {
  id: string;
  rssi: number;
  write(bytes: Uint8Array): Promise<void>;
  close(): void;
}

export interface RadioEvents {
  onAdvertisement(a: Advertisement): void;
  /** A complete inbound GATT value (already one packet) from any peer. */
  onInbound(bytes: Uint8Array): void;
  onLinkCount(n: number): void;
  onError(err: unknown): void;
}

export interface RadioAdapter {
  readonly name: string;
  readonly canScan: boolean;
  readonly canServe: boolean;
  start(events: RadioEvents): Promise<void>;
  stop(): Promise<void>;
  connect(id: string, rssi?: number): Promise<RadioLink | null>;
  linkCount(): number;
}

// --- scan duty cycle + connection policy (pure, unit-tested) ---

export interface ScanDuty {
  /** foreground scan window */
  activeMs: number;
  /** rest between windows — keeps the radio cheap and battery sane */
  idleMs: number;
}

export const DEFAULT_DUTY: ScanDuty = { activeMs: 3000, idleMs: 1500 };

/** Next duty-cycle step. `active` = should the radio be scanning now? */
export function dutyNext(isActive: boolean, d: ScanDuty = DEFAULT_DUTY): { active: boolean; ms: number } {
  return isActive ? { active: false, ms: d.idleMs } : { active: true, ms: d.activeMs };
}

export interface LinkPolicy {
  maxLinks: number;
  /** ignore candidates weaker than this (dBm) — they cost battery, relay little */
  minRssi: number;
}

export const DEFAULT_LINK_POLICY: LinkPolicy = { maxLinks: 7, minRssi: -92 };

/** Do we open a link to this candidate? Mirrors bitchat's RSSI-thresholded budget. */
export function shouldConnect(
  cand: { id: string; rssi: number; mesh?: boolean },
  connectedIds: string[],
  p: LinkPolicy = DEFAULT_LINK_POLICY
): boolean {
  if (cand.mesh === false) return false;
  if (cand.rssi < p.minRssi) return false;
  if (connectedIds.includes(cand.id)) return false;
  return connectedIds.length < p.maxLinks;
}

/** Best-first ordering for the connection budget: strongest signal first. */
export function rankCandidates(cands: Advertisement[]): Advertisement[] {
  return [...cands].filter((c) => c.mesh).sort((a, b) => b.rssi - a.rssi);
}

// --- ble-plx central role (real APIs of the installed 3.5.1 release) ---

interface LinkState {
  link: RadioLink;
  sub?: { remove(): void };
}

export class BleplxRadio implements RadioAdapter {
  readonly name = 'bleplx-central';
  readonly canScan: boolean;
  readonly canServe = false; // ble-plx has no GATT server — see file header
  private mgr: any = null;
  private events: RadioEvents | null = null;
  private links = new Map<string, LinkState>();
  private scanning = false;
  private serviceUuid: string;

  constructor(opts: { testnet?: boolean } = {}) {
    this.serviceUuid = opts.testnet ? SERVICE_UUID_TESTNET : SERVICE_UUID_MAINNET;
    let cls: any = null;
    try {
      // Lazy require keeps Expo Go / web / node tests importing this safely.
      cls = require('react-native-ble-plx').BleManager;
    } catch {
      cls = null;
    }
    this.canScan = !!cls;
    if (cls) this.mgr = new cls();
  }

  get scanServiceUuid(): string {
    return this.serviceUuid;
  }

  async start(events: RadioEvents): Promise<void> {
    this.events = events;
    if (!this.canScan) {
      events.onError(new Error('react-native-ble-plx unavailable (Expo Go / web)'));
      return;
    }
    try {
      const state = await this.mgr.state();
      if (state !== 'PoweredOn') events.onError(new Error(`bluetooth state: ${state}`));
    } catch (err) {
      events.onError(err);
    }
    this.startScan();
  }

  private startScan(): void {
    if (!this.mgr || this.scanning) return;
    this.scanning = true;
    // allowDuplicates (iOS) + AllMatches callback (Android) == bitchat's
    // "scan while active so RSSI keeps updating"; the caller duty-cycles us.
    void this.mgr
      .startDeviceScan(
        [this.serviceUuid],
        { allowDuplicates: true, callbackType: 1, scanMode: 2 },
        (error: any, device: any) => {
          if (error) {
            this.scanning = false;
            this.events?.onError(error);
            return;
          }
          if (!device?.id) return;
          const svc: string[] = device.serviceUUIDs ?? [];
          this.events?.onAdvertisement({
            id: String(device.id),
            rssi: Number(device.rssi ?? -100),
            mesh: svc.length === 0 || svc.some((u) => u.toLowerCase() === this.serviceUuid.toLowerCase()),
          });
        }
      )
      .catch((err: unknown) => {
        this.scanning = false;
        this.events?.onError(err);
      });
  }

  /** Pause/resume scanning — driven by BleTransport's duty cycle. */
  async setScanning(on: boolean): Promise<void> {
    if (!this.mgr) return;
    try {
      if (on) this.startScan();
      else {
        await this.mgr.stopDeviceScan();
        this.scanning = false;
      }
    } catch (err) {
      this.events?.onError(err);
    }
  }

  async connect(id: string, rssi = -80): Promise<RadioLink | null> {
    if (!this.mgr) return null;
    try {
      const device = await this.mgr.connectToDevice(id, { requestMTU: BLE_MTU, autoConnect: false });
      await device.discoverAllServicesAndCharacteristics();
      const sub = this.mgr.monitorCharacteristicForDevice(
        id,
        this.serviceUuid,
        CHAR_UUID,
        (error: any, value: string | null) => {
          if (error) {
            this.events?.onError(error);
            return;
          }
          if (value) this.events?.onInbound(b64decode(value));
        }
      );
      const onDisconnect = device.onDisconnected(() => this.dropLink(id));
      const link: RadioLink = {
        id,
        rssi,
        write: async (bytes) => {
          await this.mgr.writeCharacteristicWithResponseForDevice(
            id,
            this.serviceUuid,
            CHAR_UUID,
            b64encode(bytes)
          );
        },
        close: () => {
          try {
            sub?.remove();
            onDisconnect?.remove();
          } catch {}
          void device.cancelDeviceConnection?.().catch(() => {});
          this.dropLink(id);
        },
      };
      this.links.set(id, { link, sub });
      this.events?.onLinkCount(this.links.size);
      return link;
    } catch (err) {
      this.events?.onError(err);
      return null;
    }
  }

  private dropLink(id: string): void {
    if (!this.links.has(id)) return;
    this.links.delete(id);
    this.events?.onLinkCount(this.links.size);
  }

  async closeLink(id: string): Promise<void> {
    this.links.get(id)?.link.close();
  }

  connectedIds(): string[] {
    return [...this.links.keys()];
  }

  linkCount(): number {
    return this.links.size;
  }

  async stop(): Promise<void> {
    for (const id of [...this.links.keys()]) await this.closeLink(id);
    if (this.mgr && this.scanning) {
      try {
        await this.mgr.stopDeviceScan();
      } catch {}
    }
    this.scanning = false;
  }
}

// --- native peripheral role (advertise + GATT server) ---

/**
 * Talks to the optional `GhostMeshRadio` native module. When the module is not
 * in the build (Expo Go, web, iOS until the Swift counterpart lands) this
 * adapter reports `canServe = false` and everything keeps working central-only.
 */
export class NativePeripheralRadio implements RadioAdapter {
  readonly name = 'native-peripheral';
  readonly canScan = false; // this half only serves; scanning is ble-plx's job
  readonly canServe: boolean;
  private native: any = null;
  private events: RadioEvents | null = null;
  private peers = new Set<string>();
  private serviceUuid: string;

  constructor(opts: { testnet?: boolean } = {}) {
    this.serviceUuid = opts.testnet ? SERVICE_UUID_TESTNET : SERVICE_UUID_MAINNET;
    try {
      const rn = require('react-native');
      this.native = rn?.NativeModules?.GhostMeshRadio ?? null;
    } catch {
      this.native = null;
    }
    this.canServe = !!this.native?.isAvailable?.();
  }

  async start(events: RadioEvents): Promise<void> {
    this.events = events;
    if (!this.canServe) return;
    try {
      const rn = require('react-native');
      const emitter = new rn.NativeEventEmitter(this.native);
      emitter.addListener('GhostMeshWrite', (ev: { value: string; peer?: string }) => {
        if (ev?.peer) {
          const isNew = !this.peers.has(ev.peer);
          this.peers.add(ev.peer);
          if (isNew) events.onLinkCount(this.peers.size);
        }
        if (ev?.value) events.onInbound(b64decode(ev.value));
      });
      emitter.addListener('GhostMeshPeerGone', (ev: { peer?: string }) => {
        if (ev?.peer && this.peers.delete(ev.peer)) events.onLinkCount(this.peers.size);
      });
      emitter.addListener('GhostMeshError', (ev: { message?: string }) => {
        events.onError(new Error(ev?.message ?? 'peripheral error'));
      });
      await this.native.startServer(this.serviceUuid, CHAR_UUID);
      await this.native.startAdvertising(this.serviceUuid); // no local name — privacy
    } catch (err) {
      events.onError(err);
    }
  }

  /** Notify every connected central. Fragmented upstream by BleTransport. */
  async connect(): Promise<RadioLink | null> {
    if (!this.canServe) return null;
    return {
      id: '*',
      rssi: -60,
      write: async (bytes) => {
        try {
          await this.native.notifyPeers(b64encode(bytes));
        } catch (err) {
          this.events?.onError(err);
        }
      },
      close: () => {},
    };
  }

  linkCount(): number {
    return this.peers.size;
  }

  async stop(): Promise<void> {
    if (!this.canServe) return;
    try {
      await this.native.stopServer();
    } catch (err) {
      this.events?.onError(err);
    }
    this.peers.clear();
  }
}

// --- in-process radio pair (simulator + tests) ---

/**
 * Two LoopbackRadios joined by `join()` behave like two phones in range:
 * writes on one arrive as inbound on the other, advertisements are exchanged,
 * and link counts stay in sync. No timers, no hardware.
 */
export class LoopbackRadio implements RadioAdapter {
  readonly name: string;
  readonly canScan = true;
  readonly canServe = true;
  peer: LoopbackRadio | null = null;
  rssi = -55;
  private events: RadioEvents | null = null;
  private links = 0;
  private started = false;
  writes = 0;

  constructor(name = 'loopback') {
    this.name = name;
  }

  static join(a: LoopbackRadio, b: LoopbackRadio): void {
    a.peer = b;
    b.peer = a;
  }

  async start(events: RadioEvents): Promise<void> {
    this.events = events;
    this.started = true;
    if (this.peer?.started) this.exchangeAds();
  }

  private exchangeAds(): void {
    this.events?.onAdvertisement({ id: this.peer!.name, rssi: this.peer!.rssi, mesh: true });
    this.peer!.events?.onAdvertisement({ id: this.name, rssi: this.rssi, mesh: true });
  }

  async setScanning(_on: boolean): Promise<void> {
    /* always listening in the simulator */
  }

  async connect(id: string, rssi = -60): Promise<RadioLink | null> {
    if (!this.peer || id !== this.peer.name) return null;
    this.links = 1;
    if (this.peer.links === 0) this.peer.links = 1;
    this.events?.onLinkCount(this.links);
    this.peer.events?.onLinkCount(this.peer.links);
    const peer = this.peer;
    return {
      id,
      rssi,
      write: async (bytes) => {
        this.writes++;
        // deliver a copy, like a real GATT value
        peer.events?.onInbound(new Uint8Array(bytes));
      },
      close: () => {
        this.links = 0;
        peer.links = 0;
        this.events?.onLinkCount(0);
        peer.events?.onLinkCount(0);
      },
    };
  }

  linkCount(): number {
    return this.links;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.links = 0;
    this.events?.onLinkCount(0);
  }
}
