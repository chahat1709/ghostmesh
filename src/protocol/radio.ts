// radio.ts — dual-role BitChat radio. Every phone is central (scan/connect,
// react-native-ble-plx) AND peripheral (advertise/GATT, native GhostMeshBle).
// Inbound stream bytes from both roles funnel through FrameAssembler into
// complete v1 packets. Import-safe everywhere: all native access is lazy.

import { PermissionsAndroid, Platform } from 'react-native';
import {
  Peripheral,
  FrameAssembler,
  b64encode,
  b64decode,
  chunkForMtu,
  peripheralAvailable,
} from './ble';

const MAX_LINKS = 4;
const RSSI_TICK_MS = 8000;

export interface RadioEvents {
  onFrame: (frame: Uint8Array, linkId: string, rssi: number) => void;
  onLinksChanged: (count: number) => void;
}

interface CentralLink {
  id: string;
  device: any;
  mtu: number;
  rssi: number;
  monitorSub: { remove: () => void } | null;
  discSub: { remove: () => void } | null;
}

let BleManagerClass: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  BleManagerClass = require('react-native-ble-plx').BleManager;
} catch {
  BleManagerClass = null;
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
  available = Platform.OS === 'android' && (peripheralAvailable || BleManagerClass != null);
  linkCount = 0;
  private peripheral: Peripheral | null = null;
  private manager: any = null;
  private central = new Map<string, CentralLink>();
  private connecting = new Set<string>();
  private assembler = new FrameAssembler();
  private rssiTimer: any = null;
  private svc = '';
  private chr = '';

  constructor(private ev: RadioEvents) {}

  async start(serviceUuid: string, charUuid: string): Promise<{ peripheral: boolean; central: boolean; error?: string }> {
    this.svc = serviceUuid;
    this.chr = charUuid;
    if (Platform.OS !== 'android') return { peripheral: false, central: false, error: 'android-only build' };

    const perm = await requestRadioPermissions();
    if (!perm.ok) {
      return { peripheral: false, central: false, error: 'radio permission denied: ' + perm.missing.join(', ') };
    }

    // peripheral role (native)
    let perOk = false;
    try {
      this.peripheral = new Peripheral({
        onWrite: (b64, address) => {
          const linkId = 'p:' + address;
          for (const f of this.assembler.push(linkId, b64decode(b64))) {
            this.ev.onFrame(f, linkId, -70); // peripheral writes carry no RSSI; refined by central path
          }
        },
        onPeers: (n) => this.setPeripheralSubs(n),
        onState: () => {},
        onError: () => {},
      });
      perOk = await this.peripheral.start(serviceUuid, charUuid);
    } catch {
      perOk = false;
    }

    // central role (ble-plx)
    let cenOk = false;
    try {
      if (BleManagerClass) {
        this.manager = new BleManagerClass();
        this.manager.startDeviceScan([serviceUuid], { allowDuplicates: true }, (err: any, dev: any) => {
          if (err || !dev) return;
          this.onDiscovered(dev);
        });
        cenOk = true;
      }
    } catch {
      cenOk = false;
    }

    this.rssiTimer = setInterval(() => void this.refreshRssi(), RSSI_TICK_MS);
    this.syncLinks();
    if (!perOk && !cenOk) return { peripheral: false, central: false, error: 'bluetooth unavailable (is it on?)' };
    return { peripheral: perOk, central: cenOk };
  }

  /** Fan one encoded packet out to every link (peripheral notifies + central writes). */
  async broadcast(frame: Uint8Array): Promise<void> {
    const jobs: Promise<unknown>[] = [];
    if (this.peripheral) {
      jobs.push(this.peripheral.notifyFrame(b64encode(frame)).catch(() => 0));
    }
    for (const link of this.central.values()) {
      jobs.push(this.writeLink(link, frame).catch(() => null));
    }
    await Promise.all(jobs);
  }

  private async writeLink(link: CentralLink, frame: Uint8Array): Promise<void> {
    for (const chunk of chunkForMtu(frame, link.mtu)) {
      await link.device.writeCharacteristicWithoutResponseForService(this.svc, this.chr, b64encode(chunk));
    }
  }

  private onDiscovered(dev: any): void {
    const id = String(dev.id);
    const rssi = typeof dev.rssi === 'number' ? dev.rssi : -80;
    const known = this.central.get(id);
    if (known) {
      known.rssi = rssi;
      return;
    }
    if (this.central.size >= MAX_LINKS || this.connecting.has(id)) return;
    this.connecting.add(id);
    void this.connect(dev);
  }

  private async connect(dev: any): Promise<void> {
    const id = String(dev.id);
    try {
      const connected = await dev.connect({ timeout: 12000 });
      const ready = await connected.discoverAllServicesAndCharacteristics();
      let mtu = 23;
      try {
        const withMtu = await ready.requestMTU(512);
        mtu = withMtu.mtu ?? 512;
      } catch {
        mtu = 23;
      }
      let rssi = -80;
      try {
        const r = await ready.readRSSI();
        if (typeof r.rssi === 'number') rssi = r.rssi;
      } catch {}
      const link: CentralLink = { id, device: ready, mtu, rssi, monitorSub: null, discSub: null };
      link.monitorSub = ready.monitorCharacteristicForService(this.svc, this.chr, (err: any, c: any) => {
        if (err || !c?.value) return;
        const linkId = 'c:' + id;
        for (const f of this.assembler.push(linkId, b64decode(String(c.value)))) {
          const l = this.central.get(id);
          this.ev.onFrame(f, linkId, l?.rssi ?? -75);
        }
      });
      link.discSub = ready.onDisconnected(() => this.dropLink(id));
      this.central.set(id, link);
      this.syncLinks();
    } catch {
      // stay discoverable — rediscovery will retry
    } finally {
      this.connecting.delete(id);
    }
  }

  private dropLink(id: string): void {
    const link = this.central.get(id);
    if (!link) return;
    try {
      link.monitorSub?.remove();
    } catch {}
    try {
      link.discSub?.remove();
    } catch {}
    this.central.delete(id);
    this.assembler.drop('c:' + id);
    this.syncLinks();
  }

  private async refreshRssi(): Promise<void> {
    for (const link of this.central.values()) {
      try {
        const r = await link.device.readRSSI();
        if (typeof r.rssi === 'number') link.rssi = r.rssi;
      } catch {}
    }
  }

  private peripheralSubs = 0;

  setPeripheralSubs(n: number): void {
    this.peripheralSubs = n;
    this.syncLinks();
  }

  private syncLinks(): void {
    this.linkCount = this.central.size + this.peripheralSubs;
    this.ev.onLinksChanged(this.linkCount);
  }

  async stop(): Promise<void> {
    if (this.rssiTimer) {
      clearInterval(this.rssiTimer);
      this.rssiTimer = null;
    }
    try {
      this.manager?.stopDeviceScan();
    } catch {}
    for (const id of [...this.central.keys()]) {
      try {
        await this.central.get(id)?.device.cancelConnection();
      } catch {}
      this.dropLink(id);
    }
    try {
      this.manager?.destroy();
    } catch {}
    this.manager = null;
    await this.peripheral?.stop();
    this.peripheral = null;
    this.syncLinks();
  }
}
