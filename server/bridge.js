#!/usr/bin/env node
// GhostMesh bridge relay — the "far peers over uplink" half of the README.
//
// Zero dependencies, ~120 lines. It stores and forwards OPAQUE BitChat v1
// frames between phones that cannot hear each other over BLE. The relay parses
// only the 14-byte packet header for routing (sender id, recipient id, type) —
// it never touches payloads, which are Noise-encrypted (DMs) or AES-locked
// (tribe rooms) and Ed25519-signed, so it can neither read nor forge traffic.
//
//   node server/bridge.js                 # listens on :8787
//   BRIDGE_PORT=9000 node server/bridge.js
//
// Point the app at it with MeshSession.setBridgeUrl('http://your.host:8787').
// This is optional infrastructure: with no bridge URL the mesh is pure BLE.

'use strict';

const V1_MIN = 22; // 14-byte header + 8-byte sender
const FLAG_HAS_RECIPIENT = 0x01;

/** Parse just enough of a v1 header to route. Returns null for anything else. */
function routeInfo(base64) {
  let raw;
  try {
    raw = Buffer.from(String(base64), 'base64');
  } catch {
    return null;
  }
  if (raw.length < V1_MIN || raw[0] !== 1) return null;
  const flags = raw[11];
  const plen = (raw[12] << 8) | raw[13];
  if (raw.length < V1_MIN + (flags & FLAG_HAS_RECIPIENT ? 8 : 0) + plen) return null;
  return {
    type: raw[1],
    ttl: raw[2],
    sender: raw.slice(14, 22).toString('hex'),
    recipient: flags & FLAG_HAS_RECIPIENT ? raw.slice(22, 30).toString('hex') : null,
  };
}

/**
 * The relay as a plain object — no HTTP, so scripts/test-mesh.js can drive it
 * directly. `handler` below is the thin HTTP wrapper around this.
 */
function createBridge(opts = {}) {
  const clientTimeoutMs = opts.clientTimeoutMs ?? 2 * 60 * 60 * 1000;
  const holdMs = opts.holdMs ?? 60 * 60 * 1000;
  const maxQueue = opts.maxQueue ?? 500;
  const seen = new Map(); // peer -> lastSeen ms
  const mailbox = new Map(); // peer -> [{frame, ts}]
  const broadcastBox = []; // [{frame, ts, from}]

  const now = () => Date.now();

  function touch(peer) {
    seen.set(peer, now());
  }

  function alive(peer, t = now()) {
    const last = seen.get(peer);
    return last !== undefined && t - last < clientTimeoutMs;
  }

  function deliver(peer, frame) {
    let box = mailbox.get(peer);
    if (!box) {
      box = [];
      mailbox.set(peer, box);
    }
    if (box.length >= maxQueue) box.shift();
    box.push({ frame, ts: now() });
  }

  return {
    routeInfo,

    /** Accept frames from `peer`. Returns {accepted, rejected}. */
    post(peer, frames) {
      touch(peer);
      let accepted = 0;
      let rejected = 0;
      for (const f of Array.isArray(frames) ? frames : []) {
        const info = routeInfo(f);
        if (!info || info.sender !== peer) {
          rejected++; // not a v1 frame, or lying about its sender
          continue;
        }
        if (info.recipient) {
          if (alive(info.recipient)) deliver(info.recipient, f);
          else {
            let box = mailbox.get(info.recipient);
            if (!box) {
              box = [];
              mailbox.set(info.recipient, box);
            }
            if (box.length < maxQueue) box.push({ frame: f, ts: now() });
          }
        } else {
          if (broadcastBox.length >= maxQueue) broadcastBox.shift();
          broadcastBox.push({ frame: f, ts: now(), from: peer });
        }
        accepted++;
      }
      return { accepted, rejected };
    },

    /** Drain the mailbox for `peer` (also picks up broadcasts). */
    pull(peer) {
      touch(peer);
      const t = now();
      const out = [];
      const box = mailbox.get(peer);
      if (box) {
        mailbox.set(
          peer,
          box.filter((e) => {
            if (t - e.ts > holdMs) return false;
            out.push(e.frame);
            return false;
          })
        );
      }
      for (let i = broadcastBox.length - 1; i >= 0; i--) {
        const e = broadcastBox[i];
        if (t - e.ts > holdMs || e.from === peer) {
          broadcastBox.splice(i, 1);
          continue;
        }
        out.push(e.frame);
        broadcastBox.splice(i, 1);
      }
      return out;
    },

    clients(t = now()) {
      return [...seen.entries()].filter(([, last]) => t - last < clientTimeoutMs).map(([peer, last]) => ({ peer, lastSeen: last }));
    },

    stats() {
      return { clients: seen.size, mailboxes: mailbox.size, broadcasts: broadcastBox.length };
    },
  };
}

/** node:http request handler bound to a bridge instance. */
function makeHandler(bridge) {
  return async function handler(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type',
      });
      return res.end();
    }
    if (url.pathname === '/health') return json(200, { ok: true, ...bridge.stats() });

    if (url.pathname === '/frames' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try {
        parsed = JSON.parse(body || '{}');
      } catch {
        return json(400, { error: 'bad json' });
      }
      const peer = String(parsed.peer ?? '');
      if (!/^[0-9a-f]{16}$/i.test(peer)) return json(400, { error: 'peer must be a 16-hex peer id' });
      return json(200, bridge.post(peer, parsed.frames ?? []));
    }

    if (url.pathname === '/frames' && req.method === 'GET') {
      const peer = String(url.searchParams.get('peer') ?? '');
      if (!/^[0-9a-f]{16}$/i.test(peer)) return json(400, { error: 'peer must be a 16-hex peer id' });
      return json(200, { frames: bridge.pull(peer) });
    }

    return json(404, { error: 'not found' });
  };
}

module.exports = { createBridge, makeHandler, routeInfo };

if (require.main === module) {
  const http = require('http');
  const port = Number(process.env.BRIDGE_PORT ?? 8787);
  const bridge = createBridge();
  http
    .createServer(makeHandler(bridge))
    .listen(port, '0.0.0.0', () => {
      console.log(`GhostMesh bridge relay listening on 0.0.0.0:${port}`);
      console.log('Frames are stored opaque; only v1 headers are read for routing.');
    });
}
