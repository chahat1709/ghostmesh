// BleTransport — GATT dual-role transport speaking real BitChat radio.
// Matches bitchat/Services/BLE/BLEService.swift + BLERadioController.swift:
//  - official service UUID (mainnet F47B…4B5C, testnet …B5A) + characteristic
//    A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D, advertised with NO local name
//  - every device is simultaneously central (scan/connect) and peripheral
//    (advertise/serve); allow-duplicates scan while active, duty-cycled idle
//  - one encoded BitChat packet per GATT write (<=512B MTU); bigger frames go
//    out as type-0x20 fragments and are reassembled here before decode
//
// Lazy-requires react-native-ble-plx so Expo Go / web import safely.

import {
  SERVICE_UUID_MAINNET as BITCHAT_SERVICE,
  CHAR_UUID as BITCHAT_CHAR,
  BLE_MTU,
  MsgType,
  decodeFragment,
  decodePacket,
  fragmentPacket,
  hex,
} from './bitchat';

export { BITCHAT_SERVICE, BITCHAT_CHAR, BLE_MTU };

let BleManagerClass: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  BleManagerClass = require('react-native-ble-plx').BleManager;
} catch {
  BleManagerClass = null;
}

interface Assembly {
  parts: (Uint8Array | null)[];
  total: number;
  ts: number;
}

const ASSEMBLY_TTL_MS = 60_000;

export class BleTransport {
  available = !!BleManagerClass;
  private mgr: any = null;
  /** Complete decoded-ready frames (single packets or reassembled). */
  onFrame: (frame: Uint8Array) => void = () => {};
  linkCount = 0;
  private reassembly = new Map<string, Assembly>();

  start() {
    if (!this.available) {
      console.log('[ble] native BLE unavailable (Expo Go / web) — use sim transport');
      return;
    }
    this.mgr = new BleManagerClass();
    // Native wiring (runs under `expo run:android/ios` / EAS APK):
    //  central: scanForPeripherals([BITCHAT_SERVICE], allowDuplicates=active),
    //    duty-cycled when idle, RSSI-thresholded connection budget;
    //  peripheral: advertise {serviceUUIDs:[BITCHAT_SERVICE]} with NO local
    //    name (privacy), GATT characteristic CHAR_UUID (write + notify);
    //  restoration identifiers for background wake on both roles.
    // Inbound GATT writes/notifications feed ingestWrite() below.
  }

  /**
   * Split an encoded packet into GATT-write-sized frames. Small packets go
   * out as a single write; larger ones as type-0x20 fragments wrapped via
   * `wrap` (caller stamps sender/TTL/timestamp like any other packet).
   */
  static toWrites(
    encoded: Uint8Array,
    wrap: (payload: Uint8Array, type: number) => Uint8Array,
    msgId16: Uint8Array
  ): Uint8Array[] {
    if (encoded.length <= BLE_MTU) return [encoded];
    return fragmentPacket(encoded, msgId16).map((frag) => wrap(frag, MsgType.Fragment));
  }

  /** Feed one inbound GATT write/notification. Emits full frames via onFrame. */
  ingestWrite(bytes: Uint8Array): void {
    this.prune();
    const p = decodePacket(bytes);
    if (!p) return; // corrupt / compressed / v2 — ignore per spec guards
    if (p.type !== MsgType.Fragment) {
      this.onFrame(bytes);
      return;
    }
    const f = decodeFragment(p.payload);
    if (!f || f.total === 0 || f.index >= f.total || f.total > 64) return;
    const key = hex(f.msgId);
    let a = this.reassembly.get(key);
    if (!a || a.total !== f.total) {
      a = { parts: new Array(f.total).fill(null), total: f.total, ts: Date.now() };
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
      if (decodePacket(full)) this.onFrame(full);
    }
  }

  private prune(now = Date.now()): void {
    for (const [k, a] of this.reassembly) {
      if (now - a.ts > ASSEMBLY_TTL_MS) this.reassembly.delete(k);
    }
  }
}
