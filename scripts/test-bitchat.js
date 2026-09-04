// BitChat-tech interop test — compiles the real TS modules and exercises them.
// Covers: SHA-256 vector, AEAD roundtrip/tamper, Noise XX + X, binary codec,
// TTL-excluded signatures, TTL clamp rules, fragmentation, padding.
const assert = require('assert');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname + path.sep + '..';
const OUT = path.join(ROOT, '.tmp-bit');

console.log('compiling bitchat.ts + noise.ts ...');
execSync(
  `npx tsc "${path.join(ROOT, 'src', 'protocol', 'bitchat.ts')}" "${path.join(ROOT, 'src', 'crypto', 'noise.ts')}" --outDir "${OUT}" --module commonjs --target es2020 --moduleResolution node --skipLibCheck --noImplicitAny false --strict false`,
  { cwd: ROOT, stdio: 'pipe' }
);

const B = require(path.join(OUT, 'protocol', 'bitchat.js'));
const N = require(path.join(OUT, 'crypto', 'noise.js'));
const nacl = require(path.join(ROOT, 'node_modules', 'tweetnacl'));

const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const dec = (b) => Buffer.from(b).toString('utf8');
const H = (b) => Buffer.from(b).toString('hex');
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };

// 1. SHA-256 known vector
ok('sha256("abc") matches FIPS vector', () => {
  assert.strictEqual(H(N.sha256(enc('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// 2. AEAD roundtrip + tamper rejection
ok('chacha20-poly1305 roundtrip + tamper fails', () => {
  const k = N.sha256(enc('key'));
  const nonce = new Uint8Array(12).fill(7);
  const ct = N.aeadEncrypt(k, nonce, enc('ad'), enc('hello mesh'));
  assert.strictEqual(dec(N.aeadDecrypt(k, nonce, enc('ad'), ct)), 'hello mesh');
  const bad = new Uint8Array(ct); bad[0] ^= 1;
  assert.strictEqual(N.aeadDecrypt(k, nonce, enc('ad'), bad), null);
  assert.strictEqual(N.aeadDecrypt(k, nonce, enc('other-ad'), ct), null);
});

// 3. Noise XX live session both directions
ok('Noise_XX handshake + bidirectional transport', () => {
  const a = N.generateStatic(), b = N.generateStatic();
  const hs = N.xxHandshake(a, b);
  assert.ok(hs, 'handshake completes');
  const [aSend, aRecv] = hs.initiator;
  const [bSend, bRecv] = hs.responder;
  const c1 = aSend.encrypt(new Uint8Array(0), enc('ping'));
  assert.strictEqual(dec(bRecv.decrypt(new Uint8Array(0), c1)), 'ping');
  const c2 = bSend.encrypt(new Uint8Array(0), enc('pong'));
  assert.strictEqual(dec(aRecv.decrypt(new Uint8Array(0), c2)), 'pong');
  // cross-direction must fail (different keys)
  assert.strictEqual(aRecv.decrypt(new Uint8Array(0), c1), null);
});

// 4. Noise X courier seal
ok('Noise_X seal/open + wrong recipient fails', () => {
  const s = N.generateStatic(), r = N.generateStatic(), o = N.generateStatic();
  const sealed = N.sealX(s, r.pub, enc('offline mail'));
  const opened = N.openX(r, sealed, s.pub);
  assert.ok(opened && dec(opened.plaintext) === 'offline mail');
  assert.strictEqual(N.openX(o, sealed), null);
  assert.strictEqual(N.openX(r, sealed, o.pub), null); // wrong expected sender
});

// 5. Binary packet roundtrips
ok('v1 packet encode/decode (message + announce + noise)', () => {
  const sender = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const recip = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
  const chat = B.encodeChatMessage({ flags: 0, timestampMs: 1234567890123, id: 'uuid-1', sender: 'vega', content: 'yo (#ballers)' });
  assert.deepStrictEqual(B.decodeChatMessage(chat), { flags: 0, timestampMs: 1234567890123, id: 'uuid-1', sender: 'vega', content: 'yo (#ballers)', originalSender: undefined, recipientNick: undefined });
  const sig = new Uint8Array(64).fill(0xab);
  const pkt = { version: 1, type: B.MsgType.Message, ttl: 7, timestampMs: 1234567890123, senderId: sender, recipientId: recip, payload: chat, signature: sig };
  const rt = B.decodePacket(B.encodePacket(pkt));
  assert.ok(rt && rt.ttl === 7 && H(rt.senderId) === H(sender) && H(rt.signature) === H(sig) && dec(rt.payload.slice(0, 0)) === '');
  assert.strictEqual(B.isBroadcast(pkt), false);
  assert.strictEqual(B.isBroadcast({ ...pkt, recipientId: undefined }), true);
  const ann = B.encodeAnnounce({ peerId: sender, staticPub: new Uint8Array(32).fill(1), signingPub: new Uint8Array(32).fill(2), nick: 'nyx', timestampMs: 999 });
  const da = B.decodeAnnounce(ann);
  assert.ok(da && da.nick === 'nyx' && H(da.staticPub) === H(new Uint8Array(32).fill(1)));
});

// 6. Signatures survive TTL decrement (spec §4)
ok('Ed25519 signature excludes TTL byte', () => {
  const kp = nacl.sign.keyPair();
  const pkt = { version: 1, type: 2, ttl: 7, timestampMs: 42, senderId: new Uint8Array(8).fill(3), payload: enc('hi') };
  const sig = nacl.sign.detached(B.signingBytes(pkt), kp.secretKey);
  const relayed = { ...pkt, ttl: 6, signature: new Uint8Array(sig) };
  assert.ok(nacl.sign.detached.verify(B.signingBytes(relayed), relayed.signature, kp.publicKey));
});

// 7. Decode guards
ok('decoder rejects truncated / bad-version / compressed frames', () => {
  const good = B.encodePacket({ version: 1, type: 2, ttl: 7, timestampMs: 1, senderId: new Uint8Array(8), payload: enc('x') });
  assert.strictEqual(B.decodePacket(good.slice(0, 10)), null);
  const badVer = new Uint8Array(good); badVer[0] = 9;
  assert.strictEqual(B.decodePacket(badVer), null);
  const comp = new Uint8Array(good); comp[11] = 0x04;
  assert.strictEqual(B.decodePacket(comp), null);
});

// 8. TTL rules
ok('origin TTL 7, dense cap 5, relay decrement + floor', () => {
  assert.strictEqual(B.originTTL(0), 7);
  assert.strictEqual(B.originTTL(3), 7);
  assert.strictEqual(B.originTTL(6), 5);
  assert.strictEqual(B.relayTTL(7, 8, true), 5);
  assert.strictEqual(B.relayTTL(7, 2, true), 6);
  assert.strictEqual(B.relayTTL(1, 0, true), 0);
  assert.strictEqual(B.relayTTL(0, 0, true), 0);
});

// 9. Fragmentation roundtrip
ok('512B-MTU fragmentation reassembles exactly', () => {
  const big = B.encodePacket({ version: 1, type: 0x22, ttl: 7, timestampMs: 5, senderId: new Uint8Array(8).fill(9), payload: new Uint8Array(2000).fill(0x41) });
  const msgId = new Uint8Array(16).fill(0xcc);
  const frags = B.fragmentPacket(big, msgId);
  assert.ok(frags.length > 1 && frags.every((f) => f.length <= 512));
  const parts = frags.map((f) => B.decodeFragment(f));
  parts.sort((a, b) => a.index - b.index);
  const total = parts.reduce((x, p) => x + p.chunk.length, 0);
  const full = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { full.set(p.chunk, o); o += p.chunk.length; }
  assert.strictEqual(H(full), H(big));
  assert.ok(B.decodePacket(full));
});

// 10. Noise padding buckets
ok('padNoise hits 256/512/1024/2048 buckets only', () => {
  assert.strictEqual(B.padNoise(new Uint8Array(100)).length, 256);
  assert.strictEqual(B.padNoise(new Uint8Array(300)).length, 512);
  assert.strictEqual(B.padNoise(new Uint8Array(2000)).length, 2048);
  assert.strictEqual(B.padNoise(new Uint8Array(3000)).length, 3000); // too big: unpadded
});

// 11. Peer ID derivation
ok('peerId = first 8 bytes of static-key fingerprint', () => {
  const fp = N.sha256(new Uint8Array(32).fill(5));
  assert.strictEqual(H(B.peerIdFromStaticPub(fp)), H(fp.slice(0, 8)));
});

fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n✅ BitChat-tech: ${n}/11 interop tests pass`);
