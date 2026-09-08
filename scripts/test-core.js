// Core relay self-test — compiles and exercises the REAL engine, not a mirror
// of it. (It used to re-implement relay/dedupe in JS, which proved nothing
// about src/protocol/meshEngine.ts.)
//
// Covers: TTL decrement + relay, dedupe, dead/truncated/version-2 frames,
// bad signatures, karma accounting, hop distance, outbox expiry, file chunking.
const assert = require('assert');
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-core');

console.log('compiling meshEngine.ts + files.ts + crypto ...');
execSync(
  `npx tsc "${path.join(ROOT, 'src', 'protocol', 'meshEngine.ts')}" "${path.join(ROOT, 'src', 'protocol', 'files.ts')}" "${path.join(ROOT, 'src', 'crypto', 'ghostCrypto.ts')}" --outDir "${OUT}" --module commonjs --target es2020 --moduleResolution node --skipLibCheck --esModuleInterop --noImplicitAny false --strict false`,
  { cwd: ROOT, stdio: 'pipe' }
);

const { MeshEngine, hopsFromTTL } = require(path.join(OUT, 'protocol', 'meshEngine.js'));
const { encodePacket, decodePacket, MsgType, hex, ORIGIN_TTL } = require(path.join(OUT, 'protocol', 'bitchat.js'));
const { FileAssembler, chunkFile, FILE_CHUNK } = require(path.join(OUT, 'protocol', 'files.js'));
const G = require(path.join(OUT, 'crypto', 'ghostCrypto.js'));
const nacl = require(path.join(ROOT, 'node_modules', 'tweetnacl'));

const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
/** Relay is deferred by 20-60ms of jitter, so the relay assertion must wait. */
let relayedFrames = null;
let n = 0;
const ok = (name) => {
  n++;
  console.log(`  ✓ ${name}`);
};

function ident(seedHex) {
  const peerId = new Uint8Array(8);
  for (let i = 0; i < 8; i++) peerId[i] = parseInt(seedHex.slice(i * 2, i * 2 + 2), 16);
  const sg = nacl.sign.keyPair();
  return { peerId, signPub: new Uint8Array(sg.publicKey), signPriv: new Uint8Array(sg.secretKey) };
}

// ---------------------------------------------------------------- relay/TTL
{
  const me = ident('1122334455667788');
  const them = ident('aabbccddeeff0011');
  const engine = new MeshEngine(me.peerId);
  const sent = [];
  engine.transport = (f) => sent.push(f);
  engine.keyForPeer = (h) => (h === hex(them.peerId) ? them.signPub : null);

  const frame = (ttl, ts) =>
    encodePacket({
      version: 1,
      type: MsgType.Message,
      ttl,
      timestampMs: ts,
      senderId: them.peerId,
      payload: enc('hello'),
      signature: undefined,
    });

  assert.strictEqual(engine.receive(frame(ORIGIN_TTL, 1000)), 'ok', 'fresh frame accepted');
  ok('accepts a well-formed frame');

  assert.strictEqual(engine.receive(frame(ORIGIN_TTL, 1000)), 'dup', 'same frame deduped');
  ok('dedupes by sender+type+ts+payload');

  assert.strictEqual(engine.receive(frame(0, 2000)), 'dead', 'ttl 0 dies');
  ok('drops ttl 0');

  assert.strictEqual(engine.receive(new Uint8Array([1, 2, 7])), 'dead', 'truncated dies');
  ok('drops truncated frames');

  // encodePacket refuses to build v2, so hand-forge one by flipping the
  // version byte of an otherwise valid frame.
  const v1 = encodePacket({
    version: 1,
    type: MsgType.Message,
    ttl: 5,
    timestampMs: 3000,
    senderId: them.peerId,
    payload: enc('x'),
  });
  const v2 = new Uint8Array(v1);
  v2[0] = 2;
  assert.strictEqual(engine.receive(v2), 'dead', 'v2 refused');
  ok('refuses a v2 frame');

  relayedFrames = sent;
}

// ------------------------------------------------------------------ signatures
{
  const me = ident('1122334455667788');
  const them = ident('aabbccddeeff0011');
  const impostor = ident('9988776655443322');
  const engine = new MeshEngine(me.peerId);
  engine.transport = () => {};
  engine.keyForPeer = (h) => (h === hex(them.peerId) ? them.signPub : null);

  const p = {
    version: 1,
    type: MsgType.Message,
    ttl: ORIGIN_TTL,
    timestampMs: Date.now(),
    senderId: them.peerId,
    payload: enc('signed'),
  };
  const good = encodePacket({ ...p, signature: G.signBitPacket(p, them.signPriv) });
  const bad = encodePacket({ ...p, timestampMs: Date.now() + 1, signature: G.signBitPacket(p, impostor.signPriv) });

  assert.strictEqual(engine.receive(good), 'ok', 'valid signature accepted');
  ok('accepts a correctly signed frame');
  assert.strictEqual(engine.receive(bad), 'bad-sig', 'bad signature rejected');
  ok('rejects a frame signed by the wrong key');

  // TTL is excluded from the signature, so a relay can decrement it
  const relayed = decodePacket(good);
  const rettl = encodePacket({ ...relayed, ttl: 1 });
  assert.ok(G.verifyBitPacket(decodePacket(rettl), them.signPub), 'sig survives ttl change');
  ok('signature stays valid after a relay decrements ttl');
}

// ------------------------------------------------------------------- karma
{
  const me = ident('1122334455667788');
  const them = ident('aabbccddeeff0011');
  const engine = new MeshEngine(me.peerId);
  engine.transport = () => {};
  engine.keyForPeer = () => them.signPub;
  assert.strictEqual(engine.karmaFor(hex(them.peerId)), 0, 'karma starts at 0');

  for (let i = 0; i < 3; i++) {
    engine.receive(
      encodePacket({
        version: 1,
        type: MsgType.Message,
        ttl: ORIGIN_TTL,
        timestampMs: 1000 + i,
        senderId: them.peerId,
        payload: enc('m' + i),
      })
    );
  }
  assert.strictEqual(engine.karmaFor(hex(them.peerId)), 3, 'karma increments per new frame');
  ok('karma credits the peer that delivered 3 frames (was always 0)');

  engine.receive(
    encodePacket({
      version: 1,
      type: MsgType.Message,
      ttl: ORIGIN_TTL,
      timestampMs: 1000,
      senderId: me.peerId,
      payload: enc('m0'),
    })
  );
  assert.strictEqual(engine.karmaFor(hex(me.peerId)), 0, 'we never credit ourselves');
  ok('our own relay is not credited to us');
}

// ------------------------------------------------------------- hop distance
assert.strictEqual(hopsFromTTL(ORIGIN_TTL), 0, 'ttl 7 = direct');
assert.strictEqual(hopsFromTTL(5), 2, 'ttl 5 = two hops');
assert.strictEqual(hopsFromTTL(99), 0, 'clamps at 0');
ok('hopsFromTTL maps ttl decay to hop distance');

// ---------------------------------------------------------------- outbox
{
  const me = ident('1122334455667788');
  const them = ident('aabbccddeeff0011');
  const engine = new MeshEngine(me.peerId);
  engine.transport = () => {};
  const frame = encodePacket({
    version: 1,
    type: MsgType.NoiseEncrypted,
    ttl: ORIGIN_TTL,
    timestampMs: 1000,
    senderId: me.peerId,
    recipientId: them.peerId,
    payload: enc('hold me'),
  });
  engine.queueForLater(frame);
  assert.strictEqual(engine.pendingFor(them.peerId), 1, 'queued for that peer');
  assert.strictEqual(engine.exportOutbox().length, 1, 'outbox serialises');

  const clone = new MeshEngine(me.peerId);
  clone.importOutbox(engine.exportOutbox());
  assert.strictEqual(clone.pendingFor(them.peerId), 1, 'outbox round-trips');
  ok('courier outbox survives an export/import round-trip');

  engine.sweepOutbox(1000 + 8 * 24 * 3600 * 1000);
  assert.strictEqual(engine.pendingFor(them.peerId), 0, 'expired after 7 days');
  ok('outbox entries expire after the 7-day store-forward window');

  const due = clone.flushForPeer(them.peerId);
  assert.strictEqual(due.length, 1, 'flush hands back the frame');
  assert.strictEqual(clone.pendingFor(them.peerId), 0, 'flush empties the queue');
  ok('flushForPeer drains exactly that peer queue');
}

// -------------------------------------------------------------- file chunks
{
  const name = 'ghost.txt';
  const bytes = new Uint8Array(FILE_CHUNK * 2 + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  const chunks = chunkFile(name, bytes);
  assert.strictEqual(chunks.length, 3, 'three chunks');
  ok(`chunkFile splits ${bytes.length}B into ${chunks.length} frames`);

  // reordered + duplicated delivery must still reassemble byte-for-byte
  const asm = new FileAssembler();
  let done = null;
  for (const c of [chunks[2], chunks[0], chunks[2], chunks[1]]) {
    done = asm.add(c) ?? done;
  }
  assert.ok(done, 'assembled once complete');
  assert.strictEqual(done.name, name, 'name preserved');
  assert.deepStrictEqual(Buffer.from(done.bytes), Buffer.from(bytes), 'bytes identical');
  ok('reassembles out of order with a duplicate chunk');

  const { parseFileChunk } = require(path.join(OUT, 'protocol', 'files.js'));
  const partial = new FileAssembler();
  assert.strictEqual(partial.add(chunks[0]), null, 'incomplete stays null');
  assert.strictEqual(partial.progress(parseFileChunk(chunks[0]).msgId), 1 / 3, 'one of three in');
  ok('reports partial progress before completion');
}

(async () => {
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(relayedFrames && relayedFrames.length, 'relayed something');
  const relayed = decodePacket(relayedFrames[relayedFrames.length - 1]);
  assert.strictEqual(relayed.ttl, ORIGIN_TTL - 1, 'relay decrements ttl by 1');
  ok(`relays with ttl ${ORIGIN_TTL} -> ${relayed.ttl}`);

  console.log(`\n✅ GhostMesh core: ${n}/${n} groups pass (relay, dedupe, signatures, karma, hops, outbox, files)`);
})().catch((e) => {
  console.error('\n❌', e && e.message ? e.message : e);
  process.exit(1);
});
