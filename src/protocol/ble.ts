// ble.ts — base64 + MTU helpers shared by the radio bridge.
// Bluetooth itself now runs in the imported bitchat stack (native); the old
// hand-rolled peripheral/assembler/central code was removed with it.
// Pure functions only — safe to import anywhere (including web).

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
