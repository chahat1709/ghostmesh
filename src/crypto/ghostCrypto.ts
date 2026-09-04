// GhostMesh identity + app crypto on top of BitChat technology.
// Identity follows WHITEPAPER §3 exactly: one Curve25519 static key for Noise
// (SHA-256 fingerprint → 8-byte peer ID) plus one Ed25519 signing key for
// packet/announce signatures. Tribe locked-rooms (password → AES-256-GCM) and
// karma/radar stay GhostMesh extensions.

import nacl from 'tweetnacl';
import { decodeUTF8, encodeUTF8, encodeBase64, decodeBase64 } from 'tweetnacl-util';
import {
  BitPacket,
  hex,
  peerIdFromStaticPub,
  signingBytes,
  unhex,
} from '../protocol/bitchat';
import {
  StaticKeypair,
  TransportState,
  XXInitiator,
  XXResponder,
  generateStatic,
  openX,
  sealX,
  sha256,
} from './noise';

export interface Identity {
  peerId: Uint8Array; // 8-byte BitChat peer ID
  peerIdHex: string; // 16 hex chars
  staticKey: StaticKeypair; // X25519 Noise static — NEVER leaves device
  signPub: Uint8Array; // 32-byte Ed25519 verify key (announced)
  signPriv: Uint8Array; // 64-byte Ed25519 secret — RAM only
  nick: string;
  color: string;
}

export function randomHex(nBytes: number, rand: (n: number) => Uint8Array = nacl.randomBytes): string {
  return hex(rand(nBytes));
}

export function createIdentity(nick: string, color: string): Identity {
  const staticKey = generateStatic();
  const sg = nacl.sign.keyPair();
  const peerId = peerIdFromStaticPub(sha256(staticKey.pub));
  return {
    peerId,
    peerIdHex: hex(peerId),
    staticKey: { pub: staticKey.pub, priv: staticKey.priv },
    signPub: new Uint8Array(sg.publicKey),
    signPriv: new Uint8Array(sg.secretKey),
    nick: nick.slice(0, 18) || 'ghost',
    color,
  };
}

/** Ed25519 over the TTL-excluded signing bytes (§4: relays stay valid). */
export function signBitPacket(p: BitPacket, signPriv64: Uint8Array): Uint8Array {
  return new Uint8Array(nacl.sign.detached(signingBytes(p), signPriv64));
}

export function verifyBitPacket(p: BitPacket, signingPub32: Uint8Array): boolean {
  try {
    if (!p.signature || p.signature.length !== 64 || signingPub32.length !== 32) return false;
    return nacl.sign.detached.verify(signingBytes(p), p.signature, signingPub32);
  } catch {
    return false;
  }
}

export function peerIdFromHex(peerIdHex: string): Uint8Array {
  const b = unhex(peerIdHex);
  if (b.length !== 8) throw new Error('peer id must be 8 bytes');
  return b;
}

// --- Tribe locked rooms (GhostMesh ext): sha256-KDF + XSalsa20-Poly1305 ---
// Pure tweetnacl — no WebCrypto, so it runs in Hermes with zero polyfills.
// NOTE: format differs from the old WebCrypto rooms; old `GM1:` seals are unreadable.

function tribeKeyBytes(tribe: string, password: string): Uint8Array {
  let h = sha256(new TextEncoder().encode(`ghostmesh|${tribe}|v2`));
  const pw = new TextEncoder().encode(password);
  for (let i = 0; i < 10000; i++) {
    const both = new Uint8Array(h.length + pw.length + 1);
    both.set(h, 0);
    both.set(pw, h.length);
    both[both.length - 1] = i & 0xff;
    h = sha256(both);
  }
  return h; // 32 bytes
}

export function tribeKey(tribe: string, password = ''): Uint8Array {
  return tribeKeyBytes(tribe, password);
}

export function sealTribeMsg(key32: Uint8Array, plaintext: string): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(decodeUTF8(plaintext), nonce, key32);
  const out = new Uint8Array(nonce.length + box.length);
  out.set(nonce, 0);
  out.set(box, nonce.length);
  return encodeBase64(out);
}

export function openTribeMsg(key32: Uint8Array, sealed: string): string | null {
  try {
    const raw = decodeBase64(sealed);
    if (raw.length < nacl.secretbox.nonceLength + nacl.secretbox.overheadLength) return null;
    const pt = nacl.secretbox.open(
      raw.slice(nacl.secretbox.nonceLength),
      raw.slice(0, nacl.secretbox.nonceLength),
      key32
    );
    return pt ? encodeUTF8(pt) : null; // wrong password → null, stays opaque
  } catch {
    return null;
  }
}

// --- Noise DM sessions (XX live + X courier seals) ---

type Pending = { role: 'init'; h: XXInitiator } | { role: 'resp'; h: XXResponder };

export class DmSessions {
  private established = new Map<string, { send: TransportState; recv: TransportState }>();
  private pending = new Map<string, Pending>();

  constructor(private me: StaticKeypair) {}

  /** Lower peer id initiates — mirrors the bitchat handshake rule. */
  static shouldInitiate(myPeerHex: string, peerHex: string): boolean {
    return myPeerHex < peerHex;
  }

  /** -> e (48B). Transmit as a NoiseHandshake packet payload. */
  beginHandshake(peerHex: string): Uint8Array {
    const h = new XXInitiator(this.me);
    this.pending.set(peerHex, { role: 'init', h });
    return h.msg1();
  }

  /** Feed an inbound NoiseHandshake payload. Returns reply bytes + status. */
  onHandshakeBytes(peerHex: string, bytes: Uint8Array): { reply: Uint8Array | null; established: boolean } {
    const p = this.pending.get(peerHex);
    if (!p) {
      if (bytes.length !== 48) return { reply: null, established: false };
      const h = new XXResponder(this.me);
      const m2 = h.msg2(bytes);
      if (!m2) return { reply: null, established: false };
      this.pending.set(peerHex, { role: 'resp', h });
      return { reply: m2, established: false };
    }
    if (p.role === 'init') {
      if (bytes.length !== 96) return { reply: null, established: false };
      const m3 = p.h.msg3(bytes);
      if (!m3) {
        this.pending.delete(peerHex);
        return { reply: null, established: false };
      }
      const [send, recv] = p.h.split();
      this.established.set(peerHex, { send, recv });
      this.pending.delete(peerHex);
      return { reply: m3, established: true };
    }
    if (bytes.length !== 64) return { reply: null, established: false };
    if (!p.h.finish(bytes)) {
      this.pending.delete(peerHex);
      return { reply: null, established: false };
    }
    const [send, recv] = p.h.split();
    this.established.set(peerHex, { send, recv });
    this.pending.delete(peerHex);
    return { reply: null, established: true };
  }

  isReady(peerHex: string): boolean {
    return this.established.has(peerHex);
  }

  /** Encrypt inside the session; first plaintext byte is the NoisePayload type. */
  encryptTo(peerHex: string, payloadType: number, plaintext: Uint8Array): Uint8Array | null {
    const s = this.established.get(peerHex);
    if (!s) return null;
    const body = new Uint8Array(1 + plaintext.length);
    body[0] = payloadType & 0xff;
    body.set(plaintext, 1);
    return s.send.encrypt(new Uint8Array(0), body);
  }

  decryptFrom(peerHex: string, data: Uint8Array): { type: number; plaintext: Uint8Array } | null {
    const s = this.established.get(peerHex);
    if (!s || data.length < 17) return null;
    const pt = s.recv.decrypt(new Uint8Array(0), data);
    if (!pt || pt.length < 1) return null;
    return { type: pt[0], plaintext: pt.slice(1) };
  }
}

export { sealX, openX };
export type { StaticKeypair };
