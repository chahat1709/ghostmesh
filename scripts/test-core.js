// Mesh-rule self-test — compiles the REAL src/protocol/meshEngine.ts and
// src/protocol/bitchat.ts and exercises them. (This script used to re-implement
// the relay logic in JS and test the copy; it now tests the shipped code.)
//
// Covers: relay decrement, dedupe, TTL floor, dense-graph clamp, self-origin
// suppression, version/truncation guards, signature rejection, karma, and the
// fragmentation arithmetic the radio relies on.
const assert = require('assert');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-core');

console.log('compiling meshEngine.ts + bitchat.ts …');
execSync(
  [
    'npx tsc',
    `"${path.join(ROOT, 'src', 'protocol', 'meshEngine.ts')}"`,
    `"${path.join(ROOT, 'src', 'protocol', 'bitchat.ts')}"`,
    '--outDir', `"${OUT}"`,
    '--module commonjs --target es2020 --moduleResolution node',
    '--skipLibCheck --esModuleInterop --strict false --noImplicitAny false',
  ].join(' '),
  { cwd: ROOT, stdio: 'pipe' }
);

const ME = require(path.join(OUT, 'protocol', 'meshEngine.js'));
const BIT = require(path.join(OUT, 'protocol', 'bitchat.js'));
const nacl = require(path.join(ROOT, 'node_modules', 'tweetnacl'));

const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log(`  ✅ ${name}`); };

const ME_ID = new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1]);
const PEER = new Uint8Array([2, 2, 2, 2, 2, 2, 2, 2]);

function engine() {
  const e = new ME.MeshEngine(ME_ID);
  e.relayJitterMs = () => 0; // synchronous relay, no real timers
  e.sent = [];
  e.transport = (f) => e.sent.push(f);
  return e;
}

const frame = (over = {}) =>
  BIT.encodePacket({
    version: 1,
    type: BIT.MsgType.Message,
    ttl: 7,
    timestampMs: 1000,
    senderId: PEER,
    payload: enc('relay me'),
    ...over,
  });

// 1. relay decrements TTL and forwards once
ok('relays at TTL-1', () => {
  const e = engine();
  assert.strictEqual(e.receive(frame()), 'ok');
  assert.strictEqual(e.sent.length, 1, 'forwarded once');
  const fwd = BIT.decodePacket(e.sent[0]);
  assert.strictEqual(fwd.ttl, 6, 'ttl decremented');
});

// 2. dedupe
ok('dedupes repeated frames', () => {
  const e = engine();
  const f = frame();
  assert.strictEqual(e.receive(f), 'ok');
  assert.strictEqual(e.receive(f), 'dup');
  assert.strictEqual(e.receive(f), 'dup');
  assert.strictEqual(e.sent.length, 1, 'only one forward');
  assert.strictEqual(e.stats.dup, 2);
});

// 3. TTL floor
ok('TTL 0/1 never forwarded', () => {
  const e = engine();
  assert.strictEqual(e.receive(frame({ ttl: 0, timestampMs: 11 })), 'dead');
  assert.strictEqual(e.receive(frame({ ttl: 1, timestampMs: 12 })), 'ok');
  assert.strictEqual(e.sent.length, 0, 'nothing forwarded at the floor');
  assert.strictEqual(e.stats.dead, 1);
});

// 4. dense-graph clamp (§4)
ok('dense graphs clamp broadcast TTL to 5', () => {
  assert.strictEqual(BIT.originTTL(0), 7);
  assert.strictEqual(BIT.originTTL(5), 7);
  assert.strictEqual(BIT.originTTL(6), 5);
  assert.strictEqual(BIT.relayTTL(7, 8, true), 5);
  assert.strictEqual(BIT.relayTTL(7, 2, true), 6);
  const e = engine();
  e.linkCount = 9;
  e.receive(frame({ ttl: 7, timestampMs: 21 }));
  assert.strictEqual(BIT.decodePacket(e.sent[0]).ttl, 5, 'clamped on a dense node');
});

// 5. self-origin suppression (loop prevention: never relay your own frame back)
ok('never relays frames it originated', () => {
  const e = engine();
  e.receive(frame({ senderId: ME_ID, timestampMs: 31 }));
  assert.strictEqual(e.sent.length, 0, 'no echo');
});

// 6. version + truncation guards
ok('rejects v2 / truncated / compressed frames', () => {
  const e = engine();
  const good = frame({ timestampMs: 41 });
  assert.strictEqual(e.receive(good.slice(0, 10)), 'dead', 'truncated');
  const badVer = new Uint8Array(good); badVer[0] = 2;
  assert.strictEqual(e.receive(badVer), 'dead', 'v2 refused');
  const comp = new Uint8Array(good); comp[11] = 0x04;
  assert.strictEqual(e.receive(comp), 'dead', 'compressed refused');
});

// 7. signature enforcement once the key is known
ok('rejects frames signed by the wrong key', () => {
  const e = engine();
  const kp = nacl.sign.keyPair();
  const other = nacl.sign.keyPair();
  e.keyForPeer = () => kp.publicKey;
  const p = { version: 1, type: 2, ttl: 7, timestampMs: 51, senderId: PEER, payload: enc('signed') };
  const good = BIT.encodePacket({ ...p, signature: new Uint8Array(nacl.sign.detached(BIT.signingBytes(p), kp.secretKey)) });
  assert.strictEqual(e.receive(good), 'ok');
  const lie = { ...p, timestampMs: 52 };
  const bad = BIT.encodePacket({ ...lie, signature: new Uint8Array(nacl.sign.detached(BIT.signingBytes(lie), other.secretKey)) });
  assert.strictEqual(e.receive(bad), 'bad-sig');
  assert.strictEqual(e.stats.badSig, 1);
  // TTL is excluded from the signature, so relays can decrement it
  const relayed = { ...BIT.decodePacket(good), ttl: 3 };
  assert.ok(nacl.sign.detached.verify(BIT.signingBytes(relayed), relayed.signature, kp.publicKey));
});

// 8. karma (regression: it used to add 0 and credit the relayer)
ok('karma accrues for the delivering peer, not the relayer', () => {
  const e = engine();
  e.receive(frame({ timestampMs: 61 }));
  e.receive(frame({ timestampMs: 62 }));
  const peerHex = BIT.hex(PEER);
  assert.strictEqual(e.karmaFor(peerHex), 2, 'two delivered frames = karma 2');
  assert.strictEqual(e.karmaFor(BIT.hex(ME_ID)), 0, 'we do not credit ourselves');
  e.addKarma(peerHex, -99);
  assert.strictEqual(e.karmaFor(peerHex), 0, 'floors at 0');
});

// 9. hop distance from TTL decay
ok('hop distance derived from TTL decay', () => {
  assert.strictEqual(ME.hopsFromTTL(7), 0);
  assert.strictEqual(ME.hopsFromTTL(4), 3);
  assert.strictEqual(ME.hopsFromTTL(0), 7);
});

// 10. fragmentation arithmetic the radio depends on
ok('fragmentation arithmetic matches the 512B MTU', () => {
  for (const len of [512, 513, 1024, 2400, 8000]) {
    const writes = Math.max(1, Math.ceil(len / (BIT.BLE_MTU - 20)));
    const frags = BIT.fragmentPacket(new Uint8Array(len).fill(1), new Uint8Array(16).fill(9));
    assert.strictEqual(frags.length, writes, `len ${len} → ${writes} fragments`);
    assert.ok(frags.every((f) => f.length <= BIT.BLE_MTU), 'every fragment fits the MTU');
  }
});

// 11. outbox courier rules
ok('outbox holds, flushes and expires courier mail', () => {
  const e = engine();
  const recip = new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7]);
  const held = BIT.encodePacket({ version: 1, type: 0x11, ttl: 7, timestampMs: Date.now(), senderId: ME_ID, recipientId: recip, payload: enc('mail') });
  e.queueForLater(held);
  assert.strictEqual(e.pendingFor(recip), 1);
  assert.strictEqual(e.flushForPeer(new Uint8Array(8).fill(8)).length, 0, 'not for someone else');
  assert.strictEqual(e.flushForPeer(recip).length, 1, 'flushed to the right peer');
  assert.strictEqual(e.outbox.length, 0);
  const old = BIT.encodePacket({ version: 1, type: 0x11, ttl: 7, timestampMs: Date.now() - 8 * 24 * 3600 * 1000, senderId: ME_ID, recipientId: recip, payload: enc('stale') });
  e.queueForLater(old);
  e.sweepOutbox();
  assert.strictEqual(e.outbox.length, 0, 'expired past the 7-day window');
});

fs.rmSync(OUT, { recursive: true, force: true });
console.log(`\n✅ GhostMesh core: ${n}/11 tests pass (relay, dedupe, ttl, dense clamp, self-origin, guards, sigs, karma, hops, fragmentation, outbox)`);
