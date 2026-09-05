// Base64 codec that runs in Hermes, Node and the browser.
// ble-plx exchanges characteristic values as base64 strings, and RN has no
// Buffer — so a tiny dependency-free implementation keeps one code path for
// device, simulator and tests.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function b64encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += ALPHABET[b0 >> 2];
    out += ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? ALPHABET[b2 & 0x3f] : '=';
  }
  return out;
}

export function b64decode(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const c0 = ALPHABET.indexOf(clean[i]);
    const c1 = ALPHABET.indexOf(clean[i + 1]);
    const c2 = i + 2 < clean.length ? ALPHABET.indexOf(clean[i + 2]) : 0;
    const c3 = i + 3 < clean.length ? ALPHABET.indexOf(clean[i + 3]) : 0;
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (i + 2 < clean.length) out[o++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
    if (i + 3 < clean.length) out[o++] = ((c2 & 0x03) << 6) | c3;
  }
  return out.slice(0, o);
}
