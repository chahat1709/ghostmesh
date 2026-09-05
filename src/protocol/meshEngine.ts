// MeshEngine — controlled-flood relay on top of real BitChat frames.
// Relay/dedupe/TTL rules mirror WHITEPAPER §4 + MessageDeduplicationService:
//  - dedupe key = SHA-256(senderId | type | timestamp | payload)
//  - signatures exclude TTL, so relays decrement without invalidating them
//  - originate TTL 7; dense graphs (>=6 links) clamp broadcasts to 5
//  - relay jitter 20–60ms to collapse redundant floods
// GhostMesh additions on top: karma relay reputation + 7-day raw-frame
// store-forward outbox (courier-style) for offline recipients.

import nacl from 'tweetnacl';
import {
  BitPacket,
  MsgType,
  ORIGIN_TTL,
  decodeAnnounce,
  decodePacket,
  encodePacket,
  hex,
  isBroadcast,
  relayTTL,
  signingBytes,
} from './bitchat';
import { sha256 } from '../crypto/noise';
import { b64decode, b64encode } from './b64';
import { MSG_TTL_MS } from './types';

/**
 * Hops a frame has already travelled, derived from the TTL it arrived with.
 * BitChat v1 frames carry no hop counter, so distance comes from TTL decay:
 * a frame that lands with ttl 7 is direct, ttl 5 is 2 hops away. Dense-graph
 * originators start at 5, which the caller can pass in to stay exact.
 */
export function hopsFromTTL(ttl: number, origin = ORIGIN_TTL): number {
  const h = origin - ttl;
  return h < 0 ? 0 : h;
}

export type SendBytes = (frame: Uint8Array) => void;
export type RecvStatus = 'ok' | 'dup' | 'dead' | 'bad-sig' | 'unknown-key';

function u64be(v: number): Uint8Array {
  const out = new Uint8Array(8);
  let x = Math.floor(v);
  for (let i = 7; i >= 0; i--) {
    out[i] = x & 0xff;
    x = Math.floor(x / 256);
  }
  return out;
}

export class MeshEngine {
  myPeerId: Uint8Array; // 8 bytes
  linkCount = 0; // live BLE links — drives the dense-graph TTL clamp
  seen = new Map<string, number>(); // dedupeKey -> firstSeen ms
  outbox: Uint8Array[] = []; // raw encoded frames for offline recipients
  karma = new Map<string, number>(); // peerIdHex -> reputation (delivered frames)
  stats = { received: 0, accepted: 0, relayed: 0, dup: 0, dead: 0, badSig: 0 };
  /** Relay jitter. Tests inject 0 to make forwarding synchronous. */
  relayJitterMs: () => number = () => 20 + Math.random() * 40;

  onPacket: (p: BitPacket, status: RecvStatus) => void = () => {};
  transport: SendBytes = () => {};
  /** Returns the known Ed25519 signing key for a peer, or null. Fed by verified announces. */
  keyForPeer: (senderIdHex: string) => Uint8Array | null = () => null;

  constructor(myPeerId: Uint8Array) {
    if (myPeerId.length !== 8) throw new Error('myPeerId must be 8 bytes');
    this.myPeerId = myPeerId;
  }

  static dedupeKey(p: BitPacket): string {
    const pre = new Uint8Array(8 + 1 + 8 + p.payload.length);
    pre.set(p.senderId, 0);
    pre[8] = p.type & 0xff;
    pre.set(u64be(p.timestampMs), 9);
    pre.set(p.payload, 17);
    return hex(sha256(pre));
  }

  private remember(key: string): void {
    this.seen.set(key, Date.now());
    if (this.seen.size > 10000) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1] - b[1]).slice(0, 1000);
      for (const [k] of oldest) this.seen.delete(k);
    }
  }

  private isMe(id: Uint8Array): boolean {
    return id.length === 8 && id.every((b, i) => b === this.myPeerId[i]);
  }

  /** Outbound: already-encoded frame. Records dedupe + hands to transport. */
  send(frame: Uint8Array): void {
    const p = decodePacket(frame);
    if (p) this.remember(MeshEngine.dedupeKey(p));
    this.transport(frame);
  }

  /** Hold a frame for an offline recipient; flushed when they re-announce. */
  queueForLater(frame: Uint8Array): void {
    if (this.outbox.length > 200) this.outbox.shift();
    this.outbox.push(frame);
  }

  /** Pull queued frames addressed to one 8-byte peer id. */
  flushForPeer(peerId: Uint8Array): Uint8Array[] {
    const due: Uint8Array[] = [];
    this.outbox = this.outbox.filter((f) => {
      const p = decodePacket(f);
      const mine = !!p?.recipientId && p.recipientId.every((b, i) => b === peerId[i]);
      if (mine) due.push(f);
      return !mine;
    });
    return due;
  }

  /** Reputation. Positive = delivered us traffic; the radar ranks on it. */
  addKarma(peerIdHex: string, delta: number): void {
    this.karma.set(peerIdHex, Math.max(0, (this.karma.get(peerIdHex) ?? 0) + delta));
  }

  karmaFor(peerIdHex: string): number {
    return this.karma.get(peerIdHex) ?? 0;
  }

  /** Serialise the outbox so the 7-day courier survives a relaunch. */
  exportOutbox(): string[] {
    return this.outbox.map((f) => b64encode(f));
  }

  importOutbox(frames: string[]): void {
    for (const s of frames) {
      try {
        const bytes = b64decode(s);
        if (decodePacket(bytes)) this.outbox.push(bytes);
      } catch {}
    }
  }

  pendingFor(peerId: Uint8Array): number {
    return this.outbox.filter((f) => {
      const p = decodePacket(f);
      return !!p?.recipientId && p.recipientId.every((b, i) => b === peerId[i]);
    }).length;
  }

  /** Inbound frame from BLE / sim. Relays valid traffic with TTL-1 + jitter. */
  receive(raw: Uint8Array): RecvStatus {
    this.stats.received++;
    const p = decodePacket(raw);
    if (!p) {
      this.stats.dead++;
      return 'dead';
    }
    if (p.ttl <= 0) {
      this.stats.dead++;
      return 'dead';
    }
    const key = MeshEngine.dedupeKey(p);
    if (this.seen.has(key)) {
      this.stats.dup++;
      return 'dup';
    }

    let status: RecvStatus = 'ok';
    if (p.signature && p.signature.length === 64) {
      const known = this.keyForPeer(hex(p.senderId));
      if (known) {
        let ok = false;
        try {
          ok = nacl.sign.detached.verify(signingBytes(p), p.signature, known);
        } catch {
          ok = false;
        }
        if (!ok) {
          this.stats.badSig++;
          return 'bad-sig';
        }
      } else if (p.type === MsgType.Announce) {
        // Announces are self-certifying (§3): the signing key is in the
        // payload, so verify against it instead of reporting "unknown key".
        let selfSigned = false;
        try {
          const a = decodeAnnounce(p.payload);
          selfSigned =
            !!a && !!p.signature && nacl.sign.detached.verify(signingBytes(p), p.signature, a.signingPub);
        } catch {
          selfSigned = false;
        }
        status = selfSigned ? 'ok' : 'unknown-key';
      } else {
        // No key (announce not seen yet): flood on like a dumb relay, but
        // tell the app not to display it.
        status = 'unknown-key';
      }
    }

    this.remember(key);
    // Karma: a peer earns reputation by delivering us traffic we had not
    // already seen. (Previously this added 0 and the relay credited *us*.)
    // Our own frames echoing back earn nobody anything.
    if (!this.isMe(p.senderId)) this.addKarma(hex(p.senderId), 1);
    this.stats.accepted++;
    this.onPacket(p, status);

    if (!this.isMe(p.senderId)) {
      const next = relayTTL(p.ttl, this.linkCount, isBroadcast(p));
      if (next > 0) {
        const fwd = encodePacket({ ...p, ttl: next });
        this.stats.relayed++;
        const delay = this.relayJitterMs();
        if (delay <= 0) this.transport(fwd);
        else setTimeout(() => this.transport(fwd), delay);
      }
    }
    return status;
  }

  sweepOutbox(now = Date.now(), maxAgeMs = MSG_TTL_MS): void {
    this.outbox = this.outbox.filter((f) => {
      const p = decodePacket(f);
      return !!p && now - p.timestampMs < maxAgeMs;
    });
  }
}
