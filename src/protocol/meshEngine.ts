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
  decodePacket,
  encodePacket,
  hex,
  isBroadcast,
  relayTTL,
  signingBytes,
} from './bitchat';
import { sha256 } from '../crypto/noise';

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
  karma = new Map<string, number>(); // peerIdHex -> relayed count
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

  /** Inbound frame from BLE / sim. Relays valid traffic with TTL-1 + jitter. */
  receive(raw: Uint8Array): RecvStatus {
    const p = decodePacket(raw);
    if (!p) return 'dead';
    if (p.ttl <= 0) return 'dead';
    const key = MeshEngine.dedupeKey(p);
    if (this.seen.has(key)) return 'dup';

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
        if (!ok) return 'bad-sig';
      } else {
        // No key (announce not seen yet): flood on like a dumb relay, but
        // tell the app not to display it.
        status = 'unknown-key';
      }
    }

    this.remember(key);
    this.karma.set(hex(p.senderId), (this.karma.get(hex(p.senderId)) ?? 0) + 0);
    this.onPacket(p, status);

    if (!this.isMe(p.senderId)) {
      const next = relayTTL(p.ttl, this.linkCount, isBroadcast(p));
      if (next > 0) {
        const fwd = encodePacket({ ...p, ttl: next });
        const relayer = hex(this.myPeerId);
        this.karma.set(relayer, (this.karma.get(relayer) ?? 0) + 1);
        setTimeout(() => this.transport(fwd), 20 + Math.random() * 40);
      }
    }
    return status;
  }

  sweepOutbox(now = Date.now(), maxAgeMs = 7 * 24 * 3600 * 1000): void {
    this.outbox = this.outbox.filter((f) => {
      const p = decodePacket(f);
      return !!p && now - p.timestampMs < maxAgeMs;
    });
  }
}
