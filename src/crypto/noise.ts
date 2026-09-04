// Noise crypto for BitChat-compat DMs (WHITEPAPER §5).
// Implements Noise_XX_25519_ChaChaPoly_SHA256 (live sessions, mutual auth +
// forward secrecy) and Noise_X seal (one-way courier/offline mail, no FS).
// Pure TypeScript, zero new dependencies: SHA-256/HKDF/ChaCha20-Poly1305 are
// vendored below; X25519 comes from tweetnacl (already a dependency).
//
// Wire mapping: handshake bytes ride in MsgType.NoiseHandshake packets,
// session ciphertext in MsgType.NoiseEncrypted with a 1-byte NoisePayload
// type prefix (see src/protocol/bitchat.ts).

import * as nacl from 'tweetnacl';

// ---------------------------------------------------------------- SHA-256 ---

const K256 = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/** Synchronous SHA-256 (WebCrypto is async — unusable inside packet paths). */
export function sha256(msg: Uint8Array): Uint8Array {
  const ml = msg.length;
  const bitLenHi = Math.floor((ml * 8) / 0x100000000);
  const bitLenLo = (ml * 8) >>> 0;
  const padded = new Uint8Array((((ml + 9 + 63) >> 6) << 6) || 64);
  padded.set(msg, 0);
  padded[ml] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLenHi);
  dv.setUint32(padded.length - 4, bitLenLo);
  let [a, b, c, d, e, f, g, h] = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const w = new Array<number>(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [aa, bb, cc, dd, ee, ff, gg, hh] = [a, b, c, d, e, f, g, h];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(ee, 6) ^ rotr(ee, 11) ^ rotr(ee, 25);
      const ch = (ee & ff) ^ (~ee & gg);
      const t1 = (hh + S1 + ch + K256[i] + w[i]) | 0;
      const S0 = rotr(aa, 2) ^ rotr(aa, 13) ^ rotr(aa, 22);
      const maj = (aa & bb) ^ (aa & cc) ^ (bb & cc);
      const t2 = (S0 + maj) | 0;
      hh = gg;
      gg = ff;
      ff = ee;
      ee = (dd + t1) | 0;
      dd = cc;
      cc = bb;
      bb = aa;
      aa = (t1 + t2) | 0;
    }
    a = (a + aa) | 0;
    b = (b + bb) | 0;
    c = (c + cc) | 0;
    d = (d + dd) | 0;
    e = (e + ee) | 0;
    f = (f + ff) | 0;
    g = (g + gg) | 0;
    h = (h + hh) | 0;
  }
  const out = new Uint8Array(32);
  const od = new DataView(out.buffer);
  [a, b, c, d, e, f, g, h].forEach((v, i) => od.setUint32(i * 4, v >>> 0));
  return out;
}

function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  let k = key;
  if (k.length > 64) k = sha256(k);
  const kp = new Uint8Array(64);
  kp.set(k, 0);
  const ipad = new Uint8Array(64);
  const opad = new Uint8Array(64);
  for (let i = 0; i < 64; i++) {
    ipad[i] = kp[i] ^ 0x36;
    opad[i] = kp[i] ^ 0x5c;
  }
  const inner = new Uint8Array(64 + data.length);
  inner.set(ipad, 0);
  inner.set(data, 64);
  const outer = new Uint8Array(64 + 32);
  outer.set(opad, 0);
  outer.set(sha256(inner), 64);
  return sha256(outer);
}

/** Noise HKDF(ck, input, 2): temp=Extract, out1/out2=Expand (rev 34 §4). */
function hkdf2(ck: Uint8Array, input: Uint8Array): [Uint8Array, Uint8Array] {
  const temp = hmacSha256(ck, input);
  const out1 = hmacSha256(temp, new Uint8Array([0x01]));
  const both = new Uint8Array(33);
  both.set(out1, 0);
  both[32] = 0x02;
  return [out1, hmacSha256(temp, both)];
}

// ------------------------------------------------------- ChaCha20-Poly1305 ---

function qround(s: Uint32Array, a: number, b: number, c: number, d: number): void {
  s[a] = (s[a] + s[b]) | 0;
  s[d] = rotr(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) | 0;
  s[b] = rotr(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) | 0;
  s[d] = rotr(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) | 0;
  s[b] = rotr(s[b] ^ s[c], 7);
}

function chachaBlock(key: Uint8Array, counter: number, nonce12: Uint8Array): Uint8Array {
  const s = new Uint32Array(16);
  s[0] = 0x61707865;
  s[1] = 0x3320646e;
  s[2] = 0x79622d32;
  s[3] = 0x6b206574;
  const kd = new DataView(key.buffer, key.byteOffset, 32);
  for (let i = 0; i < 8; i++) s[4 + i] = kd.getUint32(i * 4, true);
  s[12] = counter >>> 0;
  const nd = new DataView(nonce12.buffer, nonce12.byteOffset, 12);
  s[13] = nd.getUint32(0, true);
  s[14] = nd.getUint32(4, true);
  s[15] = nd.getUint32(8, true);
  const w = new Uint32Array(s);
  for (let i = 0; i < 10; i++) {
    qround(w, 0, 4, 8, 12);
    qround(w, 1, 5, 9, 13);
    qround(w, 2, 6, 10, 14);
    qround(w, 3, 7, 11, 15);
    qround(w, 0, 5, 10, 15);
    qround(w, 1, 6, 11, 12);
    qround(w, 2, 7, 8, 13);
    qround(w, 3, 4, 9, 14);
  }
  const out = new Uint8Array(64);
  const od = new DataView(out.buffer);
  for (let i = 0; i < 16; i++) od.setUint32(i * 4, (w[i] + s[i]) | 0, true);
  return out;
}

const P130 = (1n << 130n) - 5n;

function leBytes(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  let x = n;
  for (let i = 0; i < len; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function leNum(b: Uint8Array): bigint {
  let x = 0n;
  for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i]);
  return x;
}

function poly1305(msg: Uint8Array, key32: Uint8Array): Uint8Array {
  const r = leNum(key32.slice(0, 16)) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leNum(key32.slice(16, 32));
  let acc = 0n;
  for (let off = 0; off < msg.length; off += 16) {
    const block = msg.slice(off, Math.min(off + 16, msg.length));
    const withOne = new Uint8Array(block.length + 1);
    withOne.set(block, 0);
    withOne[block.length] = 0x01;
    acc = ((acc + leNum(withOne)) * r) % P130;
  }
  return leBytes((acc + s) & ((1n << 128n) - 1n), 16);
}

function noiseNonce(n: number | bigint): Uint8Array {
  const out = new Uint8Array(12); // 32 zero bits + 64-bit LE n (§CipherState)
  let x = BigInt(n);
  for (let i = 0; i < 8; i++) {
    out[4 + i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function chachaXor(key: Uint8Array, nonce12: Uint8Array, data: Uint8Array, ctr0: number): Uint8Array {
  const out = new Uint8Array(data.length);
  let ctr = ctr0 >>> 0;
  for (let off = 0; off < data.length; off += 64) {
    const ks = chachaBlock(key, ctr++, nonce12);
    const n = Math.min(64, data.length - off);
    for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ ks[i];
  }
  return out;
}

function pad16Len(l: number): Uint8Array {
  return l % 16 === 0 ? new Uint8Array(0) : new Uint8Array(16 - (l % 16));
}

function le64(v: number): Uint8Array {
  const out = new Uint8Array(8);
  let x = v >>> 0;
  for (let i = 0; i < 4; i++) {
    out[i] = x & 0xff;
    x >>>= 8;
  }
  return out; // lengths < 2^32 in this protocol; high word stays zero
}

/** RFC 8439 §2.8 AEAD. Returns ciphertext||16-byte tag. */
export function aeadEncrypt(key32: Uint8Array, nonce12: Uint8Array, aad: Uint8Array, pt: Uint8Array): Uint8Array {
  const otk = chachaBlock(key32, 0, nonce12).slice(0, 32);
  const ct = chachaXor(key32, nonce12, pt, 1);
  const parts = [aad, pad16Len(aad.length), ct, pad16Len(ct.length), le64(aad.length), le64(ct.length)];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const mac = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    mac.set(p, o);
    o += p.length;
  }
  const tag = poly1305(mac, otk);
  const out = new Uint8Array(ct.length + 16);
  out.set(ct, 0);
  out.set(tag, ct.length);
  return out;
}

/** Returns plaintext or null on auth failure. */
export function aeadDecrypt(key32: Uint8Array, nonce12: Uint8Array, aad: Uint8Array, ctTag: Uint8Array): Uint8Array | null {
  if (ctTag.length < 16) return null;
  const ct = ctTag.slice(0, ctTag.length - 16);
  const tag = ctTag.slice(ctTag.length - 16);
  const otk = chachaBlock(key32, 0, nonce12).slice(0, 32);
  const parts = [aad, pad16Len(aad.length), ct, pad16Len(ct.length), le64(aad.length), le64(ct.length)];
  const total = parts.reduce((a, p) => a + p.length, 0);
  const mac = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    mac.set(p, o);
    o += p.length;
  }
  const expect = poly1305(mac, otk);
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= tag[i] ^ expect[i];
  if (diff !== 0) return null;
  return chachaXor(key32, nonce12, ct, 1);
}

// ------------------------------------------------------------------ Noise ---

const XX_NAME = new TextEncoder().encode('Noise_XX_25519_ChaChaPoly_SHA256'); // 32B
const X_NAME = new TextEncoder().encode('Noise_X_25519_ChaChaPoly_SHA256'); // 31B

export interface StaticKeypair {
  pub: Uint8Array; // 32
  priv: Uint8Array; // 32
}

export function generateStatic(): StaticKeypair {
  const kp = nacl.box.keyPair();
  return { pub: new Uint8Array(kp.publicKey), priv: new Uint8Array(kp.secretKey) };
}

function dh(priv: Uint8Array, pub: Uint8Array): Uint8Array {
  return nacl.scalarMult(priv, pub);
}

class SymmetricState {
  ck: Uint8Array;
  h: Uint8Array;
  constructor(protocolName: Uint8Array) {
    const padded = new Uint8Array(32);
    padded.set(protocolName.slice(0, 32), 0);
    this.ck = padded.slice();
    this.h = padded.slice();
  }
  mixHash(data: Uint8Array): void {
    const both = new Uint8Array(this.h.length + data.length);
    both.set(this.h, 0);
    both.set(data, this.h.length);
    this.h = sha256(both);
  }
  mixKey(input: Uint8Array): void {
    const [ck, tempK] = hkdf2(this.ck, input);
    this.ck = ck;
    this.key = tempK;
    this.nonce = 0n;
  }
  key: Uint8Array = new Uint8Array(0);
  nonce: bigint = 0n;
  encryptAndHash(pt: Uint8Array): Uint8Array {
    let out: Uint8Array;
    if (this.key.length === 0) {
      out = pt.slice();
    } else {
      const n = this.nonce;
      if (n >= (1n << 64n) - 1n) throw new Error('nonce exhausted');
      this.nonce = n + 1n;
      out = aeadEncrypt(this.key, noiseNonce(n), this.h, pt);
    }
    this.mixHash(out);
    return out;
  }
  decryptAndHash(ct: Uint8Array): Uint8Array | null {
    let pt: Uint8Array | null;
    if (this.key.length === 0) {
      pt = ct.slice();
    } else {
      const n = this.nonce;
      if (n >= (1n << 64n) - 1n) return null;
      this.nonce = n + 1n;
      pt = aeadDecrypt(this.key, noiseNonce(n), this.h, ct);
      if (!pt) return null;
    }
    this.mixHash(ct);
    return pt;
  }
  split(): [TransportState, TransportState] {
    const [t1, t2] = hkdf2(this.ck, new Uint8Array(0));
    return [new TransportState(t1), new TransportState(t2)];
  }
}

export class TransportState {
  private k: Uint8Array;
  private n: bigint = 0n;
  constructor(key32: Uint8Array) {
    this.k = key32.slice();
  }
  encrypt(ad: Uint8Array, pt: Uint8Array): Uint8Array {
    if (this.n >= (1n << 64n) - 1n) throw new Error('transport nonce exhausted');
    const out = aeadEncrypt(this.k, noiseNonce(this.n), ad, pt);
    this.n += 1n;
    return out;
  }
  decrypt(ad: Uint8Array, ct: Uint8Array): Uint8Array | null {
    if (this.n >= (1n << 64n) - 1n) return null;
    const pt = aeadDecrypt(this.k, noiseNonce(this.n), ad, ct);
    if (!pt) return null;
    this.n += 1n;
    return pt;
  }
}

// --- XX handshake roles (empty handshake payloads, rev 34 §7.5) ---

export class XXInitiator {
  private st: SymmetricState;
  private e: StaticKeypair;
  private s: StaticKeypair;
  private re: Uint8Array = new Uint8Array(0);
  constructor(staticKey: StaticKeypair) {
    this.s = staticKey;
    this.e = generateStatic();
    this.st = new SymmetricState(XX_NAME);
    this.st.mixHash(new Uint8Array(0)); // empty prologue
  }
  /** -> e. 48 bytes. */
  msg1(): Uint8Array {
    const st = this.st;
    st.mixHash(this.e.pub);
    st.mixKey(this.e.pub);
    const enc = st.encryptAndHash(new Uint8Array(0));
    const out = new Uint8Array(32 + enc.length);
    out.set(this.e.pub, 0);
    out.set(enc, 32);
    return out;
  }
  /** <- e, ee, s, es. Returns our -> s, se (64B) or null. */
  msg3(inMsg: Uint8Array): Uint8Array | null {
    const st = this.st;
    if (inMsg.length < 32) return null;
    this.re = inMsg.slice(0, 32);
    st.mixHash(this.re);
    st.mixKey(this.re);
    let off = 32;
    const take = (n: number): Uint8Array | null => {
      if (off + n > inMsg.length) return null;
      const s = inMsg.slice(off, off + n);
      off += n;
      return s;
    };
    const encS = take(48);
    const encTag = take(16);
    if (!encS || !encTag) return null;
    st.mixKey(dh(this.e.priv, this.re));
    const rs = st.decryptAndHash(encS);
    if (!rs) return null;
    st.mixKey(dh(this.e.priv, rs)); // es = DH(e_init, s_resp)
    const ok = st.decryptAndHash(encTag);
    if (!ok) return null;
    const encOurs = st.encryptAndHash(this.s.pub);
    st.mixKey(dh(this.s.priv, this.re));
    const encFinal = st.encryptAndHash(new Uint8Array(0));
    const out = new Uint8Array(encOurs.length + encFinal.length);
    out.set(encOurs, 0);
    out.set(encFinal, encOurs.length);
    return out;
  }
  split(): [TransportState, TransportState] {
    return this.st.split(); // [send, receive] for initiator
  }
}

export class XXResponder {
  private st: SymmetricState;
  private e: StaticKeypair;
  private s: StaticKeypair;
  private re: Uint8Array = new Uint8Array(0);
  constructor(staticKey: StaticKeypair) {
    this.s = staticKey;
    this.e = generateStatic();
    this.st = new SymmetricState(XX_NAME);
    this.st.mixHash(new Uint8Array(0));
  }
  /** -> e (48B) in; <- e, ee, s, es (96B) out. Null on failure. */
  msg2(inMsg: Uint8Array): Uint8Array | null {
    const st = this.st;
    if (inMsg.length < 32) return null;
    this.re = inMsg.slice(0, 32);
    st.mixHash(this.re);
    st.mixKey(this.re);
    const rest = st.decryptAndHash(inMsg.slice(32));
    if (!rest || rest.length !== 0) return null;
    st.mixHash(this.e.pub);
    st.mixKey(this.e.pub);
    st.mixKey(dh(this.e.priv, this.re));
    const encS = st.encryptAndHash(this.s.pub);
    st.mixKey(dh(this.s.priv, this.re));
    const encFinal = st.encryptAndHash(new Uint8Array(0));
    const out = new Uint8Array(32 + encS.length + encFinal.length);
    out.set(this.e.pub, 0);
    out.set(encS, 32);
    out.set(encFinal, 32 + encS.length);
    return out;
  }
  /** -> s, se (64B) in. Null on failure. */
  finish(inMsg: Uint8Array): boolean {
    const st = this.st;
    if (inMsg.length !== 64) return false;
    const rs = st.decryptAndHash(inMsg.slice(0, 48));
    if (!rs) return false;
    st.mixKey(dh(this.e.priv, rs)); // se = DH(e_resp, s_init)
    const ok = st.decryptAndHash(inMsg.slice(48));
    return !!ok && ok.length === 0;
  }
  split(): [TransportState, TransportState] {
    const [c1, c2] = this.st.split();
    return [c2, c1]; // responder sends on c2, receives on c1
  }
}

/** Run all three XX messages in-process. Returns both transport pairs. */
export function xxHandshake(
  initiatorStatic: StaticKeypair,
  responderStatic: StaticKeypair
): { initiator: [TransportState, TransportState]; responder: [TransportState, TransportState] } | null {
  const init = new XXInitiator(initiatorStatic);
  const resp = new XXResponder(responderStatic);
  const m1 = init.msg1();
  const m2 = resp.msg2(m1);
  if (!m2) return null;
  const m3 = init.msg3(m2);
  if (!m3 || !resp.finish(m3)) return null;
  return { initiator: init.split(), responder: resp.split() };
}

// --- Noise X one-way seal (courier/offline mail, WHITEPAPER §5.2) ---
// Pattern X: pre <- s; tokens -> e, es, s, ss. No forward secrecy.

export function sealX(sender: StaticKeypair, recipientPub: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const st = new SymmetricState(X_NAME);
  st.mixHash(new Uint8Array(0));
  st.mixHash(recipientPub); // pre-message <- s
  const e = generateStatic();
  st.mixHash(e.pub);
  st.mixKey(e.pub);
  st.mixKey(dh(e.priv, recipientPub)); // es
  const encS = st.encryptAndHash(sender.pub); // s
  st.mixKey(dh(sender.priv, recipientPub)); // ss
  const encBody = st.encryptAndHash(plaintext);
  const out = new Uint8Array(32 + encS.length + encBody.length);
  out.set(e.pub, 0);
  out.set(encS, 32);
  out.set(encBody, 32 + encS.length);
  return out;
}

export function openX(
  recipient: StaticKeypair,
  sealed: Uint8Array,
  expectedSenderPub?: Uint8Array
): { senderPub: Uint8Array; plaintext: Uint8Array } | null {
  if (sealed.length < 32 + 48 + 16) return null;
  const st = new SymmetricState(X_NAME);
  st.mixHash(new Uint8Array(0));
  st.mixHash(recipient.pub);
  const re = sealed.slice(0, 32);
  st.mixHash(re);
  st.mixKey(re);
  st.mixKey(dh(recipient.priv, re));
  const senderPub = st.decryptAndHash(sealed.slice(32, 80));
  if (!senderPub || senderPub.length !== 32) return null;
  if (expectedSenderPub && !senderPub.every((b, i) => b === expectedSenderPub[i])) return null;
  st.mixKey(dh(recipient.priv, senderPub));
  const plaintext = st.decryptAndHash(sealed.slice(80));
  if (!plaintext) return null;
  return { senderPub, plaintext };
}
