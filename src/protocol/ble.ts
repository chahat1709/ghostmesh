// ble.ts — peripheral-role wrapper (native GhostMeshBle module) + GATT stream
// reassembly + base64 helpers. Central role (scan/connect) lives in radio.ts
// on top of react-native-ble-plx. Safe to import in Expo Go / web: everything
// degrades to `available === false` when native code is absent.

import { NativeModules, NativeEventEmitter, Platform } from 'react-native';
import { decodePacket } from './bitchat';

const NativeBle: any | null =
  (NativeModules as any)?.GhostMeshBle ?? null;

export const peripheralAvailable =
  Platform.OS === 'android' && NativeBle != null;

export interface PeripheralEvents {
  onWrite: (base64: string, address: string) => void;
  onPeers: (count: number) => void;
  onState: (on: boolean) => void;
  onError: (message: string) => void;
}

/** Thin wrapper over the Kotlin GATT server + advertiser. */
export class Peripheral {
  available = peripheralAvailable;
  private emitter: NativeEventEmitter | null = null;
  private subs: any[] = [];

  constructor(private ev: PeripheralEvents) {}

  async start(serviceUuid: string, charUuid: string): Promise<boolean> {
    if (!this.available) return false;
    this.emitter = new NativeEventEmitter(NativeBle);
    this.subs = [
      this.emitter.addListener('GhostMeshBleWrite', (e: any) => this.ev.onWrite(String(e?.base64 ?? ''), String(e?.address ?? ''))),
      this.emitter.addListener('GhostMeshBlePeers', (e: any) => this.ev.onPeers(Number(e?.count ?? 0))),
      this.emitter.addListener('GhostMeshBleState', (e: any) => this.ev.onState(!!e?.on)),
      this.emitter.addListener('GhostMeshBleError', (e: any) => this.ev.onError(String(e?.message ?? 'ble error'))),
    ];
    try {
      return !!(await NativeBle.startAdvertising(serviceUuid, charUuid));
    } catch {
      return false;
    }
  }

  async notifyFrame(base64: string): Promise<number> {
    if (!this.available) return 0;
    try {
      return Number(await NativeBle.notifyFrame(base64)) || 0;
    } catch {
      return 0;
    }
  }

  async stop(): Promise<void> {
    for (const s of this.subs) {
      try {
        s.remove();
      } catch {}
    }
    this.subs = [];
    if (!this.available) return;
    try {
      await NativeBle.stopAdvertising();
    } catch {}
  }
}

/**
 * GATT writes/notifies arrive in MTU-sized chunks with no framing of their
 * own. Like bitchat's NotificationStreamAssembler, accumulate per-link bytes
 * until the v1 length prefix yields a complete, decodable packet.
 */
export class FrameAssembler {
  private buf = new Map<string, Uint8Array>();

  /** Feed raw stream bytes; returns any complete frames (usually 0 or 1). */
  push(linkId: string, chunk: Uint8Array): Uint8Array[] {
    const prev = this.buf.get(linkId) ?? new Uint8Array(0);
    const joined = new Uint8Array(prev.length + chunk.length);
    joined.set(prev, 0);
    joined.set(chunk, prev.length);
    // resync cap: a corrupt stream can never grow past one max frame
    const bytes = joined.length > 8192 ? joined.slice(joined.length - 8192) : joined;
    const out: Uint8Array[] = [];
    let data = bytes;
    for (;;) {
      if (data.length < 22) break; // 14 header + 8 sender minimum
      if (data[0] !== 1) {
        data = data.slice(1); // resync on version byte
        continue;
      }
      const flags = data[11];
      if (flags & 0x04) break; // compressed: we never send it; wait for more (will cap out)
      if (flags & 0x08) {
        data = data.slice(1); // v2 route flag on a stream: resync
        continue;
      }
      const plen = (data[12] << 8) | data[13];
      if (plen > 65535) {
        data = data.slice(1);
        continue;
      }
      const need = 14 + 8 + (flags & 0x01 ? 8 : 0) + plen + (flags & 0x02 ? 64 : 0);
      if (data.length < need) break;
      const frame = data.slice(0, need);
      if (decodePacket(frame)) out.push(frame);
      data = data.slice(need);
    }
    if (data.length > 0) this.buf.set(linkId, data);
    else this.buf.delete(linkId);
    return out;
  }

  drop(linkId: string): void {
    this.buf.delete(linkId);
  }
}

// --- base64 without dependencies (chunked so big frames don't blow the stack) ---

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    s += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    s += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    s += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return s;
}

export function b64decode(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
  const out: number[] = [];
  let bits = 0;
  let acc = 0;
  for (const ch of clean) {
    if (ch === '=') break;
    acc = (acc << 6) | B64.indexOf(ch);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return new Uint8Array(out);
}

/** Split bytes into MTU-payload-sized GATT writes (default link MTU 23 → 20B). */
export function chunkForMtu(bytes: Uint8Array, mtu = 23): Uint8Array[] {
  const room = Math.max(20, mtu - 3);
  if (bytes.length <= room) return [bytes];
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += room) out.push(bytes.slice(i, i + room));
  return out;
}
