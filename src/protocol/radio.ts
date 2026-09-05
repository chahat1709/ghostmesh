// radio.ts — drives the IMPORTED bitchat link layer (native GATT server +
// client managers, broadcaster, tracker). All Bluetooth lives in their code;
// this class only bridges frames/events to the TS MeshEngine. Same public API
// as before, so the app is untouched apart from the peer-ID start argument.

import { NativeModules, NativeEventEmitter, Platform, PermissionsAndroid } from 'react-native';
import { b64encode, b64decode } from './ble';

const NativeBit: any | null =
  (NativeModules as any)?.GhostMeshBle ?? null;

export interface RadioEvents {
  onFrame: (frame: Uint8Array, linkId: string, rssi: number) => void;
  onLinksChanged: (count: number) => void;
}

async function requestRadioPermissions(): Promise<{ ok: boolean; missing: string[] }> {
  if (Platform.OS !== 'android') return { ok: false, missing: ['android-only'] };
  const P = PermissionsAndroid.PERMISSIONS as any;
  const wanted = [
    P.BLUETOOTH_SCAN,
    P.BLUETOOTH_CONNECT,
    P.BLUETOOTH_ADVERTISE,
    P.ACCESS_FINE_LOCATION,
  ].filter(Boolean);
  try {
    const res = await PermissionsAndroid.requestMultiple(wanted);
    const missing = wanted.filter(
      (k: string) => res[k] !== PermissionsAndroid.RESULTS.GRANTED
    );
    return { ok: missing.length === 0, missing };
  } catch {
    return { ok: false, missing: wanted };
  }
}

export class Radio {
  available = Platform.OS === 'android' && NativeBit != null;
  linkCount = 0;
  private emitter: NativeEventEmitter | null = null;
  private subs: any[] = [];
  private rssiByAddress = new Map<string, number>();

  constructor(private ev: RadioEvents) {}

  async start(
    _serviceUuid: string,
    _charUuid: string,
    peerIdHex: string
  ): Promise<{ peripheral: boolean; central: boolean; error?: string }> {
    if (Platform.OS !== 'android' || !NativeBit) {
      return { peripheral: false, central: false, error: 'native mesh stack missing' };
    }
    const perm = await requestRadioPermissions();
    if (!perm.ok) {
      return { peripheral: false, central: false, error: 'radio permission denied: ' + perm.missing.join(', ') };
    }
    this.emitter = new NativeEventEmitter(NativeBit);
    this.subs = [
      this.emitter.addListener('GhostMeshBleFrame', (e: any) => {
        try {
          const raw = b64decode(String(e?.data ?? ''));
          if (raw.length === 0) return;
          const rssi = this.rssiByAddress.get(String(e?.address ?? '')) ?? -75;
          this.ev.onFrame(raw, String(e?.linkID ?? ''), rssi);
        } catch {}
      }),
      this.emitter.addListener('GhostMeshBlePeers', (e: any) => {
        this.linkCount = Number(e?.count ?? 0);
        this.ev.onLinksChanged(this.linkCount);
      }),
      this.emitter.addListener('GhostMeshBleRssi', (e: any) => {
        this.rssiByAddress.set(String(e?.address ?? ''), Number(e?.rssi ?? -75));
      }),
    ];
    try {
      const ok = await NativeBit.startAdvertising(peerIdHex);
      try {
        this.linkCount = Number(await NativeBit.linkCount()) || 0;
      } catch {}
      if (ok) return { peripheral: true, central: true };
      return { peripheral: false, central: false, error: 'bluetooth unavailable (is it on?)' };
    } catch (err) {
      return { peripheral: false, central: false, error: String((err as Error)?.message ?? err) };
    }
  }

  /** One encoded frame → their broadcaster floods every link (with fragmentation). */
  async broadcast(frame: Uint8Array): Promise<void> {
    if (!NativeBit) return;
    try {
      await NativeBit.broadcastFrame(b64encode(frame));
    } catch {}
  }

  async stop(): Promise<void> {
    for (const s of this.subs) {
      try {
        s.remove();
      } catch {}
    }
    this.subs = [];
    this.rssiByAddress.clear();
    if (!NativeBit) return;
    try {
      await NativeBit.stopAdvertising();
    } catch {}
    this.linkCount = 0;
    this.ev.onLinksChanged(0);
  }
}
