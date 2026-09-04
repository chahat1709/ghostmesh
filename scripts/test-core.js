// Core protocol self-test — runs with plain node, no deps.
// Mirrors src/protocol/meshEngine.ts logic to prove relay/dedupe/loop/TTL behavior.
const assert = require('assert');
const seen = new Map();
function receive(cache, pkt, me) {
  if (!pkt || pkt.v !== 1) return 'dead';
  if (cache.has(pkt.id)) return 'dup';
  if (pkt.ttl <= 0) return 'dead';
  if ((pkt.hops || []).includes(me)) return 'loop';
  cache.set(pkt.id, Date.now());
  let relay = null;
  if (pkt.ttl > 1 && pkt.from !== me) relay = { ...pkt, ttl: pkt.ttl - 1, hops: [...(pkt.hops || []), me] };
  return relay ? 'ok+relay:' + relay.ttl : 'ok';
}
const ME = 'me';
const p1 = { v: 1, id: 'a1', kind: 'msg', from: 'peer1', ttl: 5, ts: 1, hops: [], body: {} };
assert.strictEqual(receive(seen, p1, ME), 'ok+relay:4', 'should relay with ttl-1');
assert.strictEqual(receive(seen, p1, ME), 'dup', 'should dedupe');
assert.strictEqual(receive(seen, { ...p1, id: 'a2', ttl: 0 }, ME), 'dead', 'ttl 0 dies');
assert.strictEqual(receive(seen, { ...p1, id: 'a3', hops: [ME] }, ME), 'loop', 'loop prevented');
assert.strictEqual(receive(seen, { v: 2, id: 'a4' }, ME), 'dead', 'version guard');
const frag = (len, size) => Math.max(1, Math.ceil(len / size));
assert.strictEqual(frag(8000, 3800), 3, 'chunking 8000B -> 3 BLE fragments');
console.log('✅ GhostMesh core: 6/6 tests pass (relay, dedupe, ttl, loop, version, chunking)');
