#!/usr/bin/env node
/**
 * GhostMesh bridge node — zero dependencies, node:http only.
 *
 * A bridge is the one node in a mesh that has internet. Phones POST frames
 * under their own peer id and long-poll for frames the bridge is holding for
 * them. The bridge cannot read anything: frames are signed BitChat packets and
 * DM payloads are Noise-sealed. It only ever moves opaque bytes.
 *
 *   node server/bridge.js            # listens on BRIDGE_PORT (default 8787)
 *   GET  /health                     -> { ok, peers, queued }
 *   POST /frames  {peer, frames[]}   -> { accepted, rejected }
 *   GET  /frames?peer=<16 hex>       -> { frames: [...] }
 *
 * A frame whose declared sender is not the posting peer is rejected: that stops
 * one bridge client from impersonating another over the uplink.
 */
const http = require('node:http');

const PEER_RE = /^[0-9a-f]{16}$/i;

/**
 * v1 packet layout: [0] ver, [1] type, [2] ttl, [3..11] ts, [11] flags,
 * [12..14] payload length, [14..22] senderId. Reading just the header lets the
 * bridge refuse frames that claim to come from somebody else — a bridge client
 * must not be able to inject traffic as another ghost.
 */
function declaredSender(frameB64) {
  try {
    const buf = Buffer.from(frameB64, 'base64');
    if (buf.length < 22 || buf[0] !== 1) return null;
    return buf.subarray(14, 22).toString('hex');
  } catch {
    return null;
  }
}

function createBridge(opts = {}) {
  const clientTimeoutMs = opts.clientTimeoutMs ?? 2 * 60 * 60 * 1000;
  const holdMs = opts.holdMs ?? 60 * 60 * 1000;
  const maxQueue = opts.maxQueue ?? 500;
  /** peer -> { frames: [], lastSeen } */
  const clients = new Map();

  function ensure(peer, now = Date.now()) {
    let c = clients.get(peer);
    if (!c) {
      c = { frames: [], lastSeen: now };
      clients.set(peer, c);
    }
    c.lastSeen = now;
    return c;
  }

  function prune(now = Date.now()) {
    for (const [peer, c] of clients) {
      if (now - c.lastSeen > clientTimeoutMs) clients.delete(peer);
      else if (c.frames.length) {
        c.frames = c.frames.filter((f) => now - f.t < holdMs);
      }
    }
  }

  return {
    routeInfo: { clientTimeoutMs, holdMs, maxQueue },

    /** Queue frames for `peer`. Returns how many were accepted vs dropped. */
    post(peer, frames, now = Date.now()) {
      if (!PEER_RE.test(peer)) return { accepted: 0, rejected: frames.length };
      const target = ensure(peer, now);
      let accepted = 0;
      let rejected = 0;
      for (const f of frames) {
        if (typeof f !== 'string' || f.length === 0) {
          rejected++;
          continue;
        }
        const claimed = declaredSender(f);
        if (claimed === null || claimed !== peer.toLowerCase()) {
          rejected++;
          continue;
        }
        if (target.frames.length >= maxQueue) {
          target.frames.shift();
        }
        target.frames.push({ b64: f, t: now });
        accepted++;
      }
      return { accepted, rejected };
    },

    /** Hand over (and forget) everything held for `peer`. */
    pull(peer, now = Date.now()) {
      if (!PEER_RE.test(peer)) return [];
      const c = clients.get(peer);
      if (!c) return [];
      c.lastSeen = now;
      const out = c.frames.map((f) => f.b64);
      c.frames = [];
      return out;
    },

    clients: (now = Date.now()) => {
      prune(now);
      return clients.size;
    },

    stats: (now = Date.now()) => {
      prune(now);
      let queued = 0;
      for (const c of clients.values()) queued += c.frames.length;
      return { ok: true, peers: clients.size, queued };
    },
  };
}

/** Attach the bridge to a node:http server (used by both CLI and tests). */
function makeHandler(bridge) {
  return function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    const json = (code, body) => {
      const payload = JSON.stringify(body);
      res.writeHead(code, { ...cors, 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
      res.end(payload);
    };

    if (url.pathname === '/health') return json(200, bridge.stats());

    if (url.pathname === '/frames' && req.method === 'POST') {
      let raw = '';
      req.on('data', (d) => {
        raw += d;
        if (raw.length > 8 * 1024 * 1024) {
          json(413, { error: 'body too large' });
          req.destroy();
        }
      });
      req.on('end', () => {
        let body;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(400, { error: 'invalid json' });
        }
        const peer = String(body?.peer ?? '');
        const frames = Array.isArray(body?.frames) ? body.frames : null;
        if (!PEER_RE.test(peer)) return json(400, { error: 'peer must be 16 hex chars' });
        if (!frames) return json(400, { error: 'frames must be an array' });
        return json(200, bridge.post(peer, frames));
      });
      return;
    }

    if (url.pathname === '/frames' && req.method === 'GET') {
      const peer = String(url.searchParams.get('peer') ?? '');
      if (!PEER_RE.test(peer)) return json(400, { error: 'peer must be 16 hex chars' });
      return json(200, { frames: bridge.pull(peer) });
    }

    return json(404, { error: 'not found' });
  };
}

function start(port = Number(process.env.BRIDGE_PORT ?? 8787)) {
  const bridge = createBridge();
  const server = http.createServer(makeHandler(bridge));
  server.listen(port, '0.0.0.0', () => {
    console.log(`GhostMesh bridge listening on 0.0.0.0:${port}`);
    console.log('  GET  /health');
    console.log('  POST /frames  {peer, frames[]}');
    console.log('  GET  /frames?peer=<16 hex>');
  });
  return { bridge, server };
}

module.exports = { createBridge, makeHandler, start, declaredSender, PEER_RE };

if (require.main === module) start();
