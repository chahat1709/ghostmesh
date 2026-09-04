// GhostMesh identity + app crypto on top of BitChat technology.
// Identity follows WHITEPAPER §3 exactly: one Curve25519 static key for Noise
// (SHA-256 fingerprint → 8-byte peer ID) plus one Ed25519 signing key for
// packet/announce signatures. Tribe locked-rooms (password → AES-256-GCM) and
// karma/radar stay GhostMesh extensions.

import nacl from 'tweetnacl';
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

// --- Tribe locked rooms (GhostMesh ext): password -> AES-256-GCM ---

export async function tribeKey(tribe: string, password = ''): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(`ghostmesh|${tribe}|${password}`), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('ghostmesh-salt-v1'), iterations: 100000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export async function sealTribeMsg(key: CryptoKey, plaintext: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  let s = '';
  for (const b of out) s += String.fromCharCode(b);
  return btoa(s);
}

export async function openTribeMsg(key: CryptoKey, sealed: string): Promise<string | null> {
  try {
    const raw = Uint8Array.from(atob(sealed), (c) => c.charCodeAt(0));
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
    return new TextDecoder().decode(pt);
  } catch {
    return null; // wrong password — ciphertext stays opaque
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
