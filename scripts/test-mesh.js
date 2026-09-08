// End-to-end mesh test — two real MeshSessions talking through two real
// MeshEngines, wired the same way app/index.tsx wires them (engine.transport
// -> the other node's engine.receive). No radio class involved: the link layer
// is injected, which is exactly what the imported bitchat-android layer does.
//
// Covers: announces, first-contact Noise-X courier DMs, XX sessions, the
// store-and-forward outbox, chunked files, burn messages, the HTTP bridge over
// a real socket, persistence, peer expiry, panic wipe and transcript export.
const assert = require('assert');
const http = require('node:http');
const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-mesh');

console.log('compiling mesh session + engine + crypto ...');
execSync(
  `npx tsc "${path.join(ROOT, 'src', 'store', 'mesh.ts')}" "${path.join(ROOT, 'src', 'store', 'exportTranscript.ts')}" --outDir "${OUT}" --module commonjs --target es2020 --moduleResolution node --skipLibCheck --esModuleInterop --noImplicitAny false --strict false`,
  { cwd: ROOT, stdio: 'pipe' }
);

const M = require(path.join(OUT, 'store', 'mesh.js'));
const { MeshEngine, hopsFromTTL } = require(path.join(OUT, 'protocol', 'meshEngine.js'));
const B = require(path.join(OUT, 'protocol', 'bitchat.js'));
const G = require(path.join(OUT, 'crypto', 'ghostCrypto.js'));
const P = require(path.join(OUT, 'store', 'persist.js'));
const { BridgeClient } = require(path.join(OUT, 'protocol', 'bridge.js'));
const { formatTranscript } = require(path.join(OUT, 'store', 'exportTranscript.js'));
const { createBridge, makeHandler } = require(path.join(ROOT, 'server', 'bridge.js'));

const { MsgType, encodePacket, encodeAnnounce, decodeAnnounce, hex, originTTL } = B;

let n = 0;
const ok = (name) => {
  n++;
  console.log(`  ✓ ${name}`);
};
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

let clock = Date.now();
const now = () => clock;
const noTimers = { setInterval: () => 0, clearInterval: () => {} };

function makeNode(nick) {
  const id = G.createIdentity(nick, '#8b5cf6');
  const engine = new MeshEngine(id.peerId);
  const kv = new P.MemoryKv();
  const session = new M.MeshSession({
    identity: id,
    engine,
    kv,
    persist: true,
    timers: noTimers,
    now,
    peerTimeoutMs: 90_000,
  });
  const keys = new Map();
  const dms = [];
  const files = [];
  const errors = [];
  const peersSeen = [];

  session.setHandlers({
    onDm: (peer, text, mine) => dms.push({ peer, text, mine }),
    onFile: (file, from) => files.push({ file, from }),
    onError: (e) => errors.push(e),
  });

  engine.keyForPeer = (h) => keys.get(h) ?? null;

  // Mirrors app/index.tsx: the session gets first refusal, announces fall
  // through to the app handler.
  engine.onPacket = (p, status, meta) => {
    if (session.ingest(p, status, meta)) return;
    if (p.type !== MsgType.Announce) return;
    const a = decodeAnnounce(p.payload);
    if (!a) return;
    if (!G.verifyBitPacket(p, a.signingPub)) return;
    const h = hex(a.peerId);
    keys.set(h, a.signingPub);
    peersSeen.push(h);
    session.learnPeer(h, a.signingPub, {
      nick: a.nick,
      rssi: meta?.rssi ?? -70,
      hops: hopsFromTTL(p.ttl),
      staticPub: a.staticPub,
    });
    session.flushFor(h);
  };

  const node = { id, engine, session, kv, keys, dms, files, errors, peersSeen, link: null };
  node.announce = () => {
    const a = {
      peerId: id.peerId,
      staticPub: id.staticKey.pub,
      signingPub: id.signPub,
      nick: id.nick,
      timestampMs: now(),
    };
    const p = {
      version: 1,
      type: MsgType.Announce,
      ttl: originTTL(engine.linkCount),
      timestampMs: now(),
      senderId: id.peerId,
      payload: encodeAnnounce(a),
    };
    p.signature = G.signBitPacket(p, id.signPriv);
    engine.send(encodePacket(p));
  };
  return node;
}

/** Connect two nodes with a lossless in-process "radio". */
function link(a, b) {
  a.engine.transport = (f) => setTimeout(() => b.engine.receive(f, { linkId: 'sim', rssi: -55 }), 0);
  b.engine.transport = (f) => setTimeout(() => a.engine.receive(f, { linkId: 'sim', rssi: -55 }), 0);
  a.engine.linkCount = 1;
  b.engine.linkCount = 1;
}
const unlink = (x) => {
  x.engine.transport = () => {};
  x.engine.linkCount = 0;
};

(async () => {
  // ------------------------------------------------------------ 1. announces
  const A = makeNode('alice');
  const Bn = makeNode('bob');
  link(A, Bn);
  A.announce();
  Bn.announce();
  await tick(120);

  const aPeers = A.session.peerList();
  assert.strictEqual(aPeers.length, 1, 'alice sees one peer');
  assert.strictEqual(aPeers[0].peerHex, Bn.id.peerIdHex, 'it is bob');
  assert.strictEqual(aPeers[0].nick, 'bob', 'nick from the announce');
  ok('announces register peers with their announced nickname');

  assert.ok(A.session.staticFor(Bn.id.peerIdHex), 'bob static learned from announce');
  ok('the announced X25519 static is stored (enables DMs before a handshake)');

  assert.ok(A.session.karmaFor(Bn.id.peerIdHex) >= 1, 'karma moved');
  ok('karma credits the peer that delivered the announce');

  // ------------------------------------------------- 2. first-contact DM
  const r1 = A.session.sendDm(Bn.id.peerIdHex, 'hello over the mesh');
  assert.strictEqual(r1.sealed, true, 'sealed without a prior session');
  assert.strictEqual(r1.queued, false, 'bob is in range so it went out now');
  await tick(150);

  const got = Bn.dms.filter((d) => !d.mine);
  assert.strictEqual(got.length, 1, 'bob got exactly one DM');
  assert.strictEqual(got[0].text, 'hello over the mesh', 'plaintext matches');
  assert.strictEqual(got[0].peer, A.id.peerIdHex, 'attributed to alice');
  ok('first-contact DM opens with a Noise-X courier seal and decrypts');

  assert.ok(A.dms.some((d) => d.mine && d.text === 'hello over the mesh'), 'echoed to sender');
  ok('the sender sees their own DM in the thread');

  // ------------------------------------------------------ 3. XX session
  // sendDm also kicked off an XX handshake; it should be open by now.
  await tick(200);
  assert.ok(A.session.dm.isReady(Bn.id.peerIdHex) || Bn.session.dm.isReady(A.id.peerIdHex),
    'an XX session opened');
  ok('the XX handshake completes alongside the courier message');

  const before = Bn.dms.filter((d) => !d.mine).length;
  const r2 = A.session.sendDm(Bn.id.peerIdHex, 'second, over XX');
  assert.strictEqual(r2.sealed, true, 'sealed');
  await tick(150);
  const after = Bn.dms.filter((d) => !d.mine);
  assert.strictEqual(after.length, before + 1, 'second DM delivered');
  assert.strictEqual(after[after.length - 1].text, 'second, over XX', 'plaintext matches');
  ok('subsequent DMs ride the established XX session');

  // --------------------------------------------- 4. outbox / store-forward
  const C = makeNode('carol');
  link(A, C);
  C.announce();
  await tick(120);
  assert.ok(A.session.staticFor(C.id.peerIdHex), 'carol known');

  unlink(A); // carol walks out of range
  clock += 120_000; // past the 90s liveness window
  const r3 = A.session.sendDm(C.id.peerIdHex, 'read this when you are back');
  assert.strictEqual(r3.queued, true, 'held instead of sent');
  assert.strictEqual(r3.sealed, true, 'still sealed');
  // Two frames: the courier-sealed DM, plus the XX handshake held so a Noise
  // session can open as soon as carol is back.
  assert.strictEqual(A.engine.pendingFor(C.id.peerId), 2, 'dm + handshake queued for carol');
  ok('a DM to an out-of-range peer is held in the courier outbox (message + handshake)');

  assert.strictEqual(JSON.parse(A.kv.get('outbox')).length, 2, 'outbox persisted to kv');
  ok('the outbox is persisted on every queue');

  link(A, C);
  C.announce(); // re-announce triggers the flush
  await tick(150);
  const carolGot = C.dms.filter((d) => !d.mine).map((d) => d.text);
  assert.ok(carolGot.includes('read this when you are back'), 'carol got the held message');
  assert.strictEqual(A.engine.pendingFor(C.id.peerId), 0, 'queue drained');
  ok('re-announce flushes the held frame and carol decrypts it');

  // ---------------------------------------------------------- 5. files
  const bytes = new Uint8Array(1400);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) % 251;
  link(A, Bn);
  Bn.announce();
  await tick(120);
  const chunks = A.session.sendFile(Bn.id.peerIdHex, 'plan.txt', bytes);
  assert.ok(chunks >= 2, 'multi-chunk file');
  await tick(250);
  assert.strictEqual(Bn.files.length, 1, 'one file assembled');
  assert.strictEqual(Bn.files[0].file.name, 'plan.txt', 'name preserved');
  assert.deepStrictEqual(Buffer.from(Bn.files[0].file.bytes), Buffer.from(bytes), 'bytes identical');
  assert.strictEqual(Bn.files[0].from, A.id.peerIdHex, 'attributed to alice');
  ok(`chunked file (${chunks} frames, ${bytes.length}B) reassembles byte-for-byte over the mesh`);

  // ---------------------------------------------------------- 6. burn
  const parsed = M.parseBurn('[#burn:30] see you at dawn');
  assert.strictEqual(parsed.seconds, 30, 'burn seconds parsed');
  assert.strictEqual(parsed.body, 'see you at dawn', 'prefix stripped');
  assert.strictEqual(M.withBurn('plain', null), 'plain', 'no prefix without a timer');
  assert.strictEqual(M.withBurn('x', 10), '[#burn:10] x', 'prefix applied');
  ok('burn-message markers round-trip through parseBurn/withBurn');

  // -------------------------------------------------------- 7. bridge
  const bridge = createBridge();
  const server = http.createServer(makeHandler(bridge));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const client = new BridgeClient(base);

  const health = await client.health();
  assert.ok(health && health.ok, 'health endpoint answers');
  ok('bridge /health responds over a real socket');

  // A real signed frame from alice, posted under her own peer id.
  const frame = (() => {
    const p = {
      version: 1,
      type: MsgType.Message,
      ttl: 7,
      timestampMs: now(),
      senderId: A.id.peerId,
      payload: new Uint8Array(Buffer.from('via bridge', 'utf8')),
    };
    p.signature = G.signBitPacket(p, A.id.signPriv);
    return encodePacket(p);
  })();
  const posted = await client.post(A.id.peerIdHex, [frame]);
  assert.strictEqual(posted.accepted, 1, 'frame accepted');
  assert.strictEqual(posted.rejected, 0, 'nothing rejected');
  ok('a real signed frame posts to the bridge');

  const impersonated = await client.post(Bn.id.peerIdHex, [frame]);
  assert.strictEqual(impersonated.rejected, 1, 'impersonation refused');
  ok('the bridge refuses a frame posted under someone else peer id');

  const pulled = await client.pull(A.id.peerIdHex);
  assert.strictEqual(pulled.length, 1, 'frame held and returned');
  assert.deepStrictEqual(Buffer.from(pulled[0]), Buffer.from(frame), 'bytes untouched');
  assert.strictEqual((await client.pull(A.id.peerIdHex)).length, 0, 'pull drains the queue');
  ok('bridge holds opaque frames and hands them back byte-identical');

  server.close();

  // --------------------------------------------------- 8. persistence
  const shared = new P.MemoryKv();
  const D = makeNode('dave');
  const s1 = new M.MeshSession({ identity: D.id, engine: D.engine, kv: shared, timers: noTimers, now });
  s1.setTribePassword('ballers', 'hunter2');
  s1.engine.queueForLater(
    encodePacket({
      version: 1,
      type: MsgType.NoiseEncrypted,
      ttl: 7,
      timestampMs: now(),
      senderId: D.id.peerId,
      recipientId: C.id.peerId,
      payload: new Uint8Array([1, 2, 3]),
    })
  );
  s1.housekeep(); // persists the outbox

  const engine2 = new MeshEngine(D.id.peerId);
  const s2 = new M.MeshSession({ identity: D.id, engine: engine2, kv: shared, timers: noTimers, now });
  assert.strictEqual(engine2.pendingFor(C.id.peerId), 1, 'outbox survived the relaunch');
  assert.strictEqual(s2.getTribePasswords().ballers, 'hunter2', 'tribe password survived');
  ok('a relaunch restores the courier outbox and tribe passwords from kv');

  // ------------------------------------------------------ 9. peer expiry
  const before2 = A.session.peerList().length;
  assert.ok(before2 >= 1, 'alice still has peers');
  clock += 200_000; // beyond peerTimeoutMs
  A.session.housekeep();
  assert.strictEqual(A.session.peerList().length, 0, 'stale peers pruned');
  ok('peers that stop announcing are pruned after the liveness window');

  // ------------------------------------------------------ 10. status
  const st = s2.getStatus();
  assert.strictEqual(typeof st.outbox, 'number', 'outbox count');
  assert.strictEqual(st.lastError, null, 'no error yet');
  s2.fail('radio said no');
  assert.strictEqual(s2.getStatus().lastError, 'radio said no', 'error surfaces');
  s2.clearError();
  assert.strictEqual(s2.getStatus().lastError, null, 'error clears');
  ok('status exposes outbox depth and surfaces/clears errors');

  // ------------------------------------------------------- 11. wipe
  s2.wipe();
  assert.strictEqual(engine2.outbox.length, 0, 'outbox cleared');
  assert.strictEqual(shared.keys().filter((k) => k.startsWith('gm:')).length, 0, 'kv wiped');
  ok('panic wipe empties the outbox and every namespaced key');

  // --------------------------------------------------- 12. transcript
  const txt = formatTranscript(
    {
      me: { pubkey: 'aa', nick: 'alice' },
      messages: {
        lobby: [
          {
            id: '1', tribe: 'lobby', from: 'bb', nick: 'bob', color: '#fff',
            text: 'on air', ts: 1700000000000, hops: 2, mine: false, verified: true,
            expiresAt: 1700000030000,
          },
        ],
      },
      dms: {
        bb: [
          {
            id: '2', tribe: '', from: 'aa', nick: 'alice', color: '#fff',
            text: 'psst', ts: 1700000001000, hops: 1, mine: true, verified: true,
          },
        ],
      },
      peers: { bb: { pubkey: 'bb', nick: 'bob', color: '#fff', rssi: -60, lastSeen: 0, hopsAway: 1, karma: 3 } },
    },
    1700000002000
  );
  assert.ok(txt.includes('# lobby'), 'tribe section');
  assert.ok(txt.includes('bob: on air'), 'public message');
  assert.ok(txt.includes('[burns]'), 'burn marker');
  assert.ok(txt.includes('# dm bob (bb)'), 'dm section');
  assert.ok(txt.includes('you: psst'), 'own dm marked');
  ok('transcript export renders tribes, DMs and burn markers');

  console.log(`\n✅ GhostMesh mesh: ${n}/${n} groups pass (announce, courier DM, XX, outbox, files, burn, bridge, persistence, expiry, status, wipe, export)`);
})().catch((e) => {
  console.error('\n❌', e && e.stack ? e.stack : e);
  process.exit(1);
});
