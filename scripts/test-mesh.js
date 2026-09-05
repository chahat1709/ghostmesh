// GhostMesh end-to-end test — compiles the real TS modules and runs two live
// MeshSessions against each other over LoopbackRadio (no hardware, no simulator).
//
// Covers the README's feature table on real code paths: tribe posts, locked
// rooms, burn messages, Noise XX DMs, Noise X courier mail + 7-day outbox,
// chunked files, 0x20 fragmentation/reassembly, bridge relay, persistence,
// karma, peer expiry, radio duty cycle + connection budget.
const assert = require('assert');
const { execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '.tmp-mesh');

console.log('compiling src/ …');
execSync(
  [
    'npx tsc',
    `"${path.join(ROOT, 'src', 'store', 'mesh.ts')}"`,
    `"${path.join(ROOT, 'src', 'store', 'chatStore.ts')}"`,
    `"${path.join(ROOT, 'src', 'store', 'persist.ts')}"`,
    `"${path.join(ROOT, 'src', 'protocol', 'ble.ts')}"`,
    `"${path.join(ROOT, 'src', 'protocol', 'radio.ts')}"`,
    `"${path.join(ROOT, 'src', 'protocol', 'bridge.ts')}"`,
    `"${path.join(ROOT, 'src', 'protocol', 'files.ts')}"`,
    `"${path.join(ROOT, 'src', 'protocol', 'meshEngine.ts')}"`,
    '--outDir', `"${OUT}"`,
    '--module commonjs --target es2020 --moduleResolution node',
    '--skipLibCheck --esModuleInterop --strict false --noImplicitAny false',
  ].join(' '),
  { cwd: ROOT, stdio: 'pipe' }
);

// KV must be swapped to memory BEFORE chatStore loads (it hydrates at import).
const P = require(path.join(OUT, 'store', 'persist.js'));
const memKv = P.memoryKv();
P.setKv(memKv);

const M = require(path.join(OUT, 'store', 'mesh.js'));
const B = require(path.join(OUT, 'protocol', 'ble.js'));
const R = require(path.join(OUT, 'protocol', 'radio.js'));
const F = require(path.join(OUT, 'protocol', 'files.js'));
const BR = require(path.join(OUT, 'protocol', 'bridge.js'));
const ME = require(path.join(OUT, 'protocol', 'meshEngine.js'));
const BIT = require(path.join(OUT, 'protocol', 'bitchat.js'));
const store = require(path.join(OUT, 'store', 'chatStore.js'));
const { createBridge, makeHandler, routeInfo } = require(path.join(ROOT, 'server', 'bridge.js'));

let n = 0;
const ok = (name, fn) => {
  const r = fn();
  if (r && typeof r.then === 'function') return r.then(() => { n++; console.log(`  ✅ ${name}`); });
  n++;
  console.log(`  ✅ ${name}`);
  return Promise.resolve();
};

const settle = (times = 8) => {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
};

class ManualTimer {
  constructor() { this.map = new Map(); this.n = 0; }
  set(fn) { const id = ++this.n; this.map.set(id, fn); return id; }
  clear(id) { this.map.delete(id); }
  fireAll() { for (const [id, fn] of [...this.map]) { this.map.delete(id); fn(); } }
  size() { return this.map.size; }
}

const enc = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const H = (b) => Buffer.from(b).toString('hex');

/** Two sessions wired to each other by loopback radios, no real timers. */
function pair({ aNick = 'alice', bNick = 'nyx', bridgeUrl = '' } = {}) {
  const ra = new B.LoopbackRadio('A');
  const rb = new B.LoopbackRadio('B');
  B.LoopbackRadio.join(ra, rb);
  const timer = new ManualTimer();
  const mk = (nick, radio, handlers) =>
    new M.MeshSession({
      identity: M.createIdentity(nick, '#8b5cf6'),
      radios: [radio],
      handlers,
      timer,
      announceEveryMs: 10 ** 9, // manual ticks only
      peerTimeoutMs: 120_000,
      persist: false,
      relayJitterMs: () => 0,
      bridgeUrl,
    });
  const inbox = { a: [], b: [], dmsA: [], dmsB: [], filesA: [], filesB: [], peersA: [], peersB: [] };
  const A = mk(aNick, ra, {
    onMessage: (m) => inbox.a.push(m),
    onDm: (p, m) => inbox.dmsA.push([p, m]),
    onFile: (f) => inbox.filesA.push(f),
    onPeer: (p) => inbox.peersA.push(p),
  });
  const Bs = mk(bNick, rb, {
    onMessage: (m) => inbox.b.push(m),
    onDm: (p, m) => inbox.dmsB.push([p, m]),
    onFile: (f) => inbox.filesB.push(f),
    onPeer: (p) => inbox.peersB.push(p),
  });
  return { A, B: Bs, ra, rb, timer, inbox };
}

async function main() {
  // 1. two ghosts find each other and exchange signed announces
  const p = pair();
  await p.A.start();
  await p.B.start();
  await settle();
  await ok('announce exchange links two sessions over the radio', () => {
    assert.strictEqual(p.A.peers().length, 1, 'alice sees nyx');
    assert.strictEqual(p.B.peers().length, 1, 'nyx sees alice');
    assert.strictEqual(p.A.transport.linkCount, 1, 'central link established');
    assert.ok(p.inbox.peersA[0].nick === 'nyx', 'peer nick from announce');
  });

  // 2. public tribe post crosses the mesh, tagged + hop-counted
  await ok('tribe post routes to #ballers with hop count', () => {
    p.A.postTribe('ballers', 'meet at the pier');
    const got = p.inbox.b.find((m) => m.tribe === 'ballers');
    assert.ok(got, 'nyx received the ballers post');
    assert.strictEqual(got.text, 'meet at the pier');
    assert.strictEqual(got.nick, 'alice');
    assert.strictEqual(got.verified, true);
    assert.strictEqual(got.hops, 0, 'direct link = 0 hops');
    assert.ok(!p.inbox.b.some((m) => m.tribe === 'lobby' && m.text === 'meet at the pier'), 'not leaked into lobby');
  });

  // 3. locked room: wrong password stays opaque, right password opens
  await ok('locked room (GM1:) needs the password', () => {
    p.A.setPassword('trade', 's3cret');
    p.A.postTribe('trade', 'price is 40');
    const locked = p.inbox.b.find((m) => m.tribe === 'trade');
    assert.ok(locked, 'nyx got a trade post');
    assert.strictEqual(locked.text, '🔒 locked room — set the password to read');
    p.B.setPassword('trade', 's3cret');
    p.A.postTribe('trade', 'price is 41');
    const opened = p.inbox.b.filter((m) => m.tribe === 'trade').pop();
    assert.strictEqual(opened.text, 'price is 41');
    p.B.setPassword('trade', 'wrong');
    p.A.postTribe('trade', 'price is 42');
    const bad = p.inbox.b.filter((m) => m.tribe === 'trade').pop();
    assert.strictEqual(bad.text, '🔒 locked room — set the password to read');
  });

  // 4. burn messages carry an expiry the receiver applies
  await ok('burn-after message sets expiresAt on both ends', () => {
    const before = Date.now();
    p.A.postTribe('lobby', 'this disappears', { burnSeconds: 30 });
    const mine = p.inbox.a[p.inbox.a.length - 1];
    const theirs = p.inbox.b.filter((m) => m.tribe === 'lobby').pop();
    assert.ok(mine.expiresAt && mine.expiresAt - before >= 29_000 && mine.expiresAt - before <= 31_000);
    assert.ok(theirs.expiresAt, 'receiver also burns it');
    assert.strictEqual(theirs.text, 'this disappears', 'tag stripped from display text');
    assert.deepStrictEqual(M.parseBurn('[#burn:7] hi'), { seconds: 7, body: 'hi' });
    assert.strictEqual(M.parseBurn('no tag').seconds, 0);
    assert.strictEqual(M.withBurn(0, 'x'), 'x');
  });

  // 5. Noise X courier DM, then a real XX session for forward secrecy
  await ok('DM: courier seal first, Noise XX after handshake', async () => {
    const bHex = p.B.identity.peerIdHex;
    const aHex = p.A.identity.peerIdHex;
    const first = p.A.sendDm(bHex, 'offline-style hello');
    assert.ok(first, 'sendDm returned a mode');
    assert.ok(first.mode === 'courier' || first.mode === 'xx', `mode was ${first.mode}`);
    await settle();
    const got = p.inbox.dmsB.pop();
    assert.ok(got, 'nyx decrypted the DM');
    assert.strictEqual(got[1].text, 'offline-style hello');
    assert.strictEqual(got[0], aHex, 'attributed to alice');
    // handshake ran opportunistically; drive it to completion
    await settle(12);
    assert.ok(p.A.dm.ready(bHex), 'alice has an XX session');
    assert.ok(p.B.dm.ready(aHex), 'nyx has an XX session');
    const second = p.A.sendDm(bHex, 'now forward-secret');
    assert.strictEqual(second.mode, 'xx', 'second DM rides the session');
    await settle();
    assert.strictEqual(p.inbox.dmsB.pop()[1].text, 'now forward-secret');
  });

  // 6. courier outbox: offline peer gets mail later, and it survives a relaunch
  await ok('7-day courier outbox queues + flushes + persists', () => {
    const { signBitPacket } = require(path.join(OUT, 'crypto', 'ghostCrypto.js'));
    const target = M.createIdentity('wanderer', '#f59e0b');
    const mk = (radios) =>
      new M.MeshSession({
        identity: M.createIdentity('hermit', '#06b6d4'),
        radios, timer: new ManualTimer(), announceEveryMs: 10 ** 9,
        persist: false, relayJitterMs: () => 0,
      });
    const announceFrame = (ts) => {
      const a = {
        version: 1, type: BIT.MsgType.Announce, ttl: 7, timestampMs: ts,
        senderId: target.peerId,
        payload: BIT.encodeAnnounce({
          peerId: target.peerId, staticPub: target.staticKey.pub, signingPub: target.signPub,
          nick: 'wanderer', timestampMs: ts,
        }),
      };
      return BIT.encodePacket({ ...a, signature: signBitPacket(a, target.signPriv) });
    };

    const lone = mk([new B.LoopbackRadio('L')]);
    assert.strictEqual(lone.sendDm(target.peerIdHex, 'nothing yet'), null, 'unknown key → nothing forged');
    assert.strictEqual(lone.engine.receive(announceFrame(Date.now())), 'ok', 'announce accepted');
    lone.prunePeers(Date.now() + 10 ** 7); // they walked away again
    const queued = lone.sendDm(target.peerIdHex, 'still here?');
    assert.strictEqual(queued.mode, 'queued', 'offline peer → held in outbox');
    assert.strictEqual(lone.engine.outbox.length, 1);
    assert.strictEqual(lone.engine.pendingFor(target.peerId), 1);

    const serialised = lone.engine.exportOutbox();
    assert.strictEqual(serialised.length, 1, 'outbox serialises for MMKV');
    const revived = mk([new B.LoopbackRadio('L2')]);
    revived.engine.importOutbox(serialised);
    assert.strictEqual(revived.engine.outbox.length, 1, 'outbox survives a relaunch');

    const emitted = [];
    revived.engine.transport = (f) => emitted.push(f);
    revived.engine.receive(announceFrame(Date.now() + 1)); // they walk back in
    const courier = emitted.filter((f) => {
      const d = BIT.decodePacket(f);
      return d && d.type === BIT.MsgType.NoiseEncrypted && d.recipientId && H(d.recipientId) === target.peerIdHex;
    });
    assert.strictEqual(courier.length, 1, 'the held DM was couriered on sight');
    assert.strictEqual(revived.engine.outbox.length, 0, 'outbox drained');
  });

  // 7. chunked files reassemble byte-identical
  await ok('chunked file (type 0x22) reassembles exactly', async () => {
    const bytes = new Uint8Array(3000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    const chunks = p.A.sendFile('mix.bin', bytes);
    assert.ok(chunks > 1, `split into ${chunks} chunks`);
    await settle(16);
    const got = p.inbox.filesB.pop();
    assert.ok(got, 'nyx reassembled the file');
    assert.strictEqual(got.name, 'mix.bin');
    assert.strictEqual(got.bytes.length, bytes.length);
    assert.strictEqual(H(got.bytes), H(bytes), 'byte-identical');
    // every chunk, once wrapped in a signed packet, must fit one GATT write
    const longName = 'x'.repeat(63);
    for (const c of F.splitFile(longName, bytes)) {
      assert.ok(c.length <= BIT.BLE_MTU - 14 - 8 - 64, `chunk ${c.length} fits the MTU`);
      const wrapped = BIT.encodePacket({
        version: 1, type: BIT.MsgType.FileTransfer, ttl: 7, timestampMs: 1,
        senderId: new Uint8Array(8), payload: c, signature: new Uint8Array(64),
      });
      assert.ok(wrapped.length <= BIT.BLE_MTU, `signed packet ${wrapped.length} <= ${BIT.BLE_MTU}`);
    }
  });

  // 8. >512B frames fragment to 0x20 and reassemble through the transport
  await ok('oversize frames fragment to 0x20 and reassemble', async () => {
    const ta = new B.LoopbackRadio('ta');
    const tb = new B.LoopbackRadio('tb');
    B.LoopbackRadio.join(ta, tb);
    const recv = [];
    const outA = new B.BleTransport({ radios: [ta], now: () => Date.now() });
    const outB = new B.BleTransport({ radios: [tb], now: () => Date.now() });
    outB.onFrame = (f) => recv.push(f);
    await outA.start();
    await outB.start();
    await settle();
    assert.strictEqual(outA.linkCount, 1, 'transport connected to its peer');

    const big = BIT.encodePacket({
      version: 1, type: BIT.MsgType.FileTransfer, ttl: 7, timestampMs: 12345,
      senderId: new Uint8Array(8).fill(4), payload: new Uint8Array(2400).fill(0x5a),
    });
    assert.ok(big.length > BIT.BLE_MTU, 'frame is oversize');
    const expectedWrites = Math.ceil(big.length / (BIT.BLE_MTU - 20));
    assert.strictEqual(B.BleTransport.writeCount(big.length), expectedWrites);
    assert.ok(expectedWrites > 1, `needs ${expectedWrites} GATT writes`);

    await outA.send(big);
    await settle();
    assert.strictEqual(recv.length, 1, 'exactly one reassembled frame');
    assert.strictEqual(H(recv[0]), H(big), 'identical after reassembly');
    assert.strictEqual(outB.stats.reassembled, 1);
    assert.ok(outA.stats.fragmentsSent >= expectedWrites, 'fragments actually went out');

    const before = recv.length;
    outB.ingestWrite(new Uint8Array(5));
    assert.strictEqual(recv.length, before, 'corrupt write dropped');
    assert.strictEqual(outB.stats.dropped >= 1, true);
    await outA.stop();
    await outB.stop();
  });

  // 9. bridge relay: two phones that cannot hear each other still talk
  await ok('bridge relay carries frames between out-of-range peers', async () => {
    const bridge = createBridge();
    const server = http.createServer(makeHandler(bridge));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const timer = new ManualTimer();
    const idA = M.createIdentity('bridgeA', '#8b5cf6');
    const idB = M.createIdentity('bridgeB', '#06b6d4');
    const a = new BR.BridgeClient({ url, peerIdHex: idA.peerIdHex, timer });
    const b = new BR.BridgeClient({ url, peerIdHex: idB.peerIdHex, timer });
    const got = [];
    b.onFrame = (f) => got.push(f);
    const frame = BIT.encodePacket({
      version: 1, type: BIT.MsgType.Message, ttl: 7, timestampMs: 1, senderId: idA.peerId,
      recipientId: idB.peerId, payload: enc('over the uplink'),
    });
    a.queue(frame);
    assert.strictEqual(a.queued(), 1);
    await a.publishQueued();
    assert.strictEqual(a.stats.published, 1);
    const pulled = await b.poll();
    assert.strictEqual(pulled, 1, 'recipient pulled one frame');
    assert.strictEqual(H(got[0]), H(frame));
    assert.strictEqual(b.stats.online, true);
    // the relay must refuse frames that lie about their sender
    const lie = await fetch(`${url}/frames`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peer: idA.peerIdHex, frames: [Buffer.from(frame).toString('base64'), 'not-a-frame'] }),
    });
    const lieJson = await lie.json();
    assert.strictEqual(lieJson.rejected, 1, 'non-v1 frame rejected');
    assert.strictEqual(routeInfo(Buffer.from(frame).toString('base64')).recipient, idB.peerIdHex);
    const health = await (await fetch(`${url}/health`)).json();
    assert.strictEqual(health.ok, true);
    server.close();
  });

  // 10. persistence: identity + messages survive a relaunch, panic wipe erases
  await ok('MMKV-backed persistence + panic wipe', () => {
    const id = M.createIdentity('persisted', '#10b981');
    M.saveIdentity(id);
    const back = M.loadIdentity();
    assert.ok(back, 'identity reloaded');
    assert.strictEqual(back.peerIdHex, id.peerIdHex);
    assert.strictEqual(back.nick, 'persisted');
    assert.strictEqual(H(back.signPriv), H(id.signPriv), 'signing key restored');
    assert.strictEqual(H(back.staticKey.priv), H(id.staticKey.priv), 'noise static restored');
    // sign with the restored key and verify with the original public key
    const pkt = { version: 1, type: 2, ttl: 7, timestampMs: 9, senderId: back.peerId, payload: enc('x') };
    const { verifyBitPacket } = require(path.join(OUT, 'crypto', 'ghostCrypto.js'));
    assert.ok(verifyBitPacket({ ...pkt, signature: require(path.join(OUT, 'crypto', 'ghostCrypto.js')).signBitPacket(pkt, back.signPriv) }, id.signPub));

    const st = store.useChat.getState();
    st.pushMsg({ id: 'm1', tribe: 'lobby', from: 'aa', nick: 'a', color: '#fff', text: 'keep', ts: 1, hops: 0, mine: false, verified: true });
    st.pushMsg({ id: 'm2', tribe: 'lobby', from: 'aa', nick: 'a', color: '#fff', text: 'burn me', ts: 2, hops: 0, mine: false, verified: true, expiresAt: Date.now() - 10 });
    const dropped = st.pruneExpired();
    assert.strictEqual(dropped, 1, 'expired message pruned');
    assert.strictEqual(store.useChat.getState().messages.lobby.length, 1);
    assert.ok(P.kv.get(P.KEYS.messages), 'messages persisted to kv');
    store.useChat.getState().panicWipe();
    assert.strictEqual(store.useChat.getState().messages.lobby.length, 0);
    assert.strictEqual(P.loadJson(P.KEYS.messages), null, 'panic wipe cleared storage');
    assert.strictEqual(P.loadJson(P.KEYS.identity), null, 'panic wipe cleared identity');
  });

  // 11. karma actually accrues (regression: it used to add 0)
  await ok('karma rewards peers that deliver traffic', () => {
    const k = p.A.engine.karmaFor(p.B.identity.peerIdHex);
    assert.ok(k > 0, `nyx karma = ${k}`);
    p.A.engine.addKarma('zz', -5);
    assert.strictEqual(p.A.engine.karmaFor('zz'), 0, 'karma floors at 0');
  });

  // 12. hops derive from TTL decay
  await ok('hop count derived from TTL decay', () => {
    assert.strictEqual(ME.hopsFromTTL(7), 0);
    assert.strictEqual(ME.hopsFromTTL(5), 2);
    assert.strictEqual(ME.hopsFromTTL(0), 7);
    assert.strictEqual(ME.hopsFromTTL(9), 0, 'never negative');
    assert.strictEqual(BIT.originTTL(6), 5, 'dense graph cap');
  });

  // 13. peers expire, dedupe + bad signatures still enforced
  await ok('peer expiry, dedupe and signature checks', () => {
    p.A.upsertPeer({ pubkey: 'ghost1', nick: 'gone', color: '#fff', rssi: -80, lastSeen: Date.now() - 10 ** 7, hopsAway: 1, karma: 0 });
    p.A.prunePeers();
    assert.ok(!p.A.peers().some((x) => x.pubkey === 'ghost1'), 'stale peer dropped');

    const eng = new ME.MeshEngine(new Uint8Array(8).fill(1));
    eng.relayJitterMs = () => 0;
    let sent = 0;
    eng.transport = () => { sent++; };
    const frame = BIT.encodePacket({ version: 1, type: 2, ttl: 7, timestampMs: 7, senderId: new Uint8Array(8).fill(2), payload: enc('hi') });
    assert.strictEqual(eng.receive(frame), 'ok');
    assert.strictEqual(eng.receive(frame), 'dup');
    assert.strictEqual(eng.receive(BIT.encodePacket({ version: 1, type: 2, ttl: 0, timestampMs: 8, senderId: new Uint8Array(8).fill(2), payload: enc('hi') })), 'dead');
    assert.strictEqual(sent, 1, 'relayed once, not twice');
    const nacl = require(path.join(ROOT, 'node_modules', 'tweetnacl'));
    const kp = nacl.sign.keyPair();
    const evil = { version: 1, type: 2, ttl: 7, timestampMs: 11, senderId: new Uint8Array(8).fill(3), payload: enc('lie') };
    const signed = BIT.encodePacket({ ...evil, signature: new Uint8Array(nacl.sign.detached(BIT.signingBytes(evil), kp.secretKey)) });
    eng.keyForPeer = () => kp.publicKey;
    assert.strictEqual(eng.receive(signed), 'ok', 'good signature accepted');
    const other = nacl.sign.keyPair();
    const lying = { version: 1, type: 2, ttl: 7, timestampMs: 12, senderId: new Uint8Array(8).fill(3), payload: enc('lie') };
    const badSig = BIT.encodePacket({ ...lying, signature: new Uint8Array(nacl.sign.detached(BIT.signingBytes(lying), other.secretKey)) });
    assert.strictEqual(eng.receive(badSig), 'bad-sig', 'signature by the wrong key rejected');
  });

  // 14. radio duty cycle + connection budget
  await ok('duty cycle, RSSI budget and candidate ranking', () => {
    assert.deepStrictEqual(R.dutyNext(true, { activeMs: 3000, idleMs: 1500 }), { active: false, ms: 1500 });
    assert.deepStrictEqual(R.dutyNext(false, { activeMs: 3000, idleMs: 1500 }), { active: true, ms: 3000 });
    const ids = ['a', 'b'];
    assert.strictEqual(R.shouldConnect({ id: 'c', rssi: -60, mesh: true }, ids), true);
    assert.strictEqual(R.shouldConnect({ id: 'c', rssi: -99, mesh: true }, ids), false, 'too weak');
    assert.strictEqual(R.shouldConnect({ id: 'a', rssi: -60, mesh: true }, ids), false, 'already linked');
    assert.strictEqual(R.shouldConnect({ id: 'c', rssi: -60, mesh: false }, ids), false, 'not our service');
    assert.strictEqual(R.shouldConnect({ id: 'c', rssi: -60, mesh: true }, ['1','2','3','4','5','6','7']), false, 'budget full');
    const ranked = R.rankCandidates([
      { id: 'x', rssi: -90, mesh: true }, { id: 'y', rssi: -40, mesh: true }, { id: 'z', rssi: -10, mesh: false },
    ]);
    assert.deepStrictEqual(ranked.map((c) => c.id), ['y', 'x'], 'strongest mesh peer first');
  });

  // 14b. Android runtime permissions (declared in the manifest is not enough)
  await ok('Android runtime BLE permissions are requested per API level', async () => {
    assert.deepStrictEqual(R.androidPermissionsFor(34), R.ANDROID_BLE_PERMS_API31);
    assert.deepStrictEqual(R.androidPermissionsFor(31), R.ANDROID_BLE_PERMS_API31);
    assert.deepStrictEqual(R.androidPermissionsFor(30), R.ANDROID_BLE_PERMS_LEGACY, 'pre-31 needs location');
    assert.ok(R.ANDROID_BLE_PERMS_API31.includes('android.permission.BLUETOOTH_ADVERTISE'));
    // a refused adapter must surface a reason, not fail silently
    const denied = {
      name: 'denied', canScan: true, canServe: false,
      blockedBy: 'Bluetooth permission denied: BLUETOOTH_SCAN',
      start: async () => {}, stop: async () => {}, connect: async () => null, linkCount: () => 0,
    };
    const t = new B.BleTransport({ radios: [denied], timer: new ManualTimer(), now: () => Date.now() });
    await t.start();
    assert.strictEqual(t.blockedBy, 'Bluetooth permission denied: BLUETOOTH_SCAN');
    await t.stop();
    // and MeshSession lifts it into status.lastError for the UI
    const sess = new M.MeshSession({
      identity: M.createIdentity('blocked', '#ef4444'), radios: [denied],
      timer: new ManualTimer(), announceEveryMs: 10 ** 9, persist: false, relayJitterMs: () => 0,
    });
    await sess.start();
    assert.strictEqual(sess.status().lastError, 'Bluetooth permission denied: BLUETOOTH_SCAN');
    await sess.stop();
  });

  // 15. transport wiring: engine frames reach the radio, radio frames reach the engine
  await ok('engine ↔ transport wiring is bidirectional', async () => {
    const q = pair({ aNick: 'wire1', bNick: 'wire2' });
    await q.A.start();
    await q.B.start();
    await settle();
    assert.ok(q.ra.writes > 0, 'alice put frames on air');
    assert.ok(q.B.engine.stats.received > 0, 'nyx engine received them');
    assert.ok(q.B.engine.stats.accepted > 0);
    assert.strictEqual(q.B.engine.stats.badSig, 0, 'no bad signatures in a healthy mesh');
    const st = q.A.status();
    assert.strictEqual(st.started, true);
    assert.strictEqual(st.radio.scan, true);
    await q.A.stop();
    await q.B.stop();
    assert.strictEqual(q.A.isStarted, false);
  });

  await p.A.stop();
  await p.B.stop();

  fs.rmSync(OUT, { recursive: true, force: true });
  console.log(`\n✅ GhostMesh end-to-end: ${n}/16 test groups pass`);
}

main().catch((err) => {
  console.error(`\n❌ ${err && err.stack ? err.stack : err}`);
  fs.rmSync(OUT, { recursive: true, force: true });
  process.exit(1);
});
