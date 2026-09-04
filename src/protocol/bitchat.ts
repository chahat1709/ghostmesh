// BitChat-compatible wire layer (ported from permissionlesstech/bitchat).
// Spec sources: WHITEPAPER.md (§3 identity, §4 BLE mesh, §5 Noise),
// bitchat/Protocols/BinaryProtocol.swift, bitchat/Protocols/BitchatProtocol.swift,
// bitchat/Services/BLE/BLEService.swift (UUIDs).
//
// Anything marked [GM-EXT] is a GhostMesh extension riding inside the official
// framing (custom Noise payload types >= 0x80, tribe tags in message text).

// --- Radio identity (BLEService.swift) ---
export const SERVICE_UUID_MAINNET = 'F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5C';
export const SERVICE_UUID_TESTNET = 'F47B5E2D-4A9E-4C5A-9B3F-8E1D2C3A4B5A'; // #if DEBUG
export const CHAR_UUID = 'A1B2C3D4-E5F6-4A5B-8C9D-0E1F2A3B4C5D';
export const BLE_MTU = 512; // bleMaxMTU — larger frames go out as type 0x20 fragments
export const NO_ADVERTISED_NAME = true; // privacy: service UUID only, no Local Name

// --- Mesh rules (WHITEPAPER §4) ---
export const ORIGIN_TTL = 7; // packets originate with TTL 7
export const MAX_HOPS = 7;
export const DENSE_LINK_THRESHOLD = 6; // dense graphs (>=6 links)…
export const DENSE_TTL_CAP = 5; // …cap broadcast TTL at 5
export const BROADCAST_ID = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

/** Origin TTL: dense neighbourhoods cap broadcasts at 5, everyone else 7. */
export function originTTL(linkCount: number): number {
  return linkCount >= DENSE_LINK_THRESHOLD ? DENSE_TTL_CAP : ORIGIN_TTL;
}

/** Relay TTL: decrement; never forward at 0; dense graphs clamp broadcasts to 5. */
export function relayTTL(incomingTTL: number, linkCount: number, isBroadcast: boolean): number {
  if (incomingTTL <= 1) return 0;
  const dec = incomingTTL - 1;
  if (isBroadcast && linkCount >= DENSE_LINK_THRESHOLD) return Math.min(dec, DENSE_TTL_CAP);
  return dec;
}

// --- Packet types (BitchatProtocol.swift MessageType) ---
export const MsgType = {
  Announce: 0x01,
  Message: 0x02,
  Leave: 0x03,
  NoiseHandshake: 0x10,
  NoiseEncrypted: 0x11,
  Fragment: 0x20,
  RequestSync: 0x21,
  FileTransfer: 0x22,
} as const;

// --- Typed payloads inside noiseEncrypted (NoisePayloadType) ---
export const NoisePayload = {
  PrivateMessage: 0x01,
  ReadReceipt: 0x02,
  Delivered: 0x03,
  VerifyChallenge: 0x10,
  VerifyResponse: 0x11,
  TribeMessage: 0x80, // [GM-EXT] GhostMesh tribe post inside a Noise session
  TribeInvite: 0x81, // [GM-EXT] password-room invite
} as const;

// --- Header flags (BinaryProtocol.swift) ---
export const Flag = {
  HasRecipient: 0x01,
  HasSignature: 0x02,
  IsCompressed: 0x04,
  HasRoute: 0x08, // v2 only
  IsRSR: 0x10,
} as const;

// --- Message payload flags (BitchatMessage) ---
export const MsgFlag = {
  IsRelay: 0x01,
  IsPrivate: 0x02,
  HasOriginalSender: 0x04,
} as const;

export interface BitPacket {
  version: 1; // v1 only (14-byte header). v2 (+source route) is future work.
  type: number;
  ttl: number;
  timestampMs: number; // UInt64 ms, big-endian
  senderId: Uint8Array; // 8 bytes
  recipientId?: Uint8Array; // 8 bytes when HasRecipient
  payload: Uint8Array;
  signature?: Uint8Array; // 64 bytes Ed25519 when HasSignature
}

const V1_HEADER = 14;
const MAX_PAYLOAD = 65535;

function concat(...parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u16be(v: number): Uint8Array {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}

function u64be(v: number): Uint8Array {
  const out = new Uint8Array(8);
  let x = Math.floor(v);
  for (let i = 7; i >= 0; i--) {
    out[i] = x & 0xff;
    x = Math.floor(x / 256);
  }
  return out;
}

/** Encode a v1 packet. Throws on oversize/undersize fields. */
export function encodePacket(p: BitPacket): Uint8Array {
  if (p.version !== 1) throw new Error('only v1 supported');
  if (p.senderId.length !== 8) throw new Error('senderId must be 8 bytes');
  if (p.recipientId && p.recipientId.length !== 8) throw new Error('recipientId must be 8 bytes');
  if (p.signature && p.signature.length !== 64) throw new Error('signature must be 64 bytes');
  if (p.payload.length > MAX_PAYLOAD) throw new Error('payload too large');
  let flags = 0;
  if (p.recipientId) flags |= Flag.HasRecipient;
  if (p.signature) flags |= Flag.HasSignature;
  return concat(
    new Uint8Array([1, p.type & 0xff, p.ttl & 0xff]),
    u64be(p.timestampMs),
    new Uint8Array([flags]),
    u16be(p.payload.length),
    p.senderId,
    p.recipientId ?? new Uint8Array(0),
    p.payload,
    p.signature ?? new Uint8Array(0)
  );
}

/** Strict decode. Returns null on any truncation / bad version / overrun. */
export function decodePacket(raw: Uint8Array): BitPacket | null {
  try {
    if (raw.length < V1_HEADER + 8) return null;
    let o = 0;
    const ver = raw[o++];
    if (ver !== 1) return null;
    const type = raw[o++];
    const ttl = raw[o++];
    let ts = 0;
    for (let i = 0; i < 8; i++) ts = ts * 256 + raw[o++];
    const flags = raw[o++];
    const plen = (raw[o++] << 8) | raw[o++];
    if (flags & Flag.IsCompressed) return null; // we never send compressed; refuse opaque blobs
    if (flags & Flag.HasRoute) return null; // v2-only flag on a v1 frame
    const hasRecipient = (flags & Flag.HasRecipient) !== 0;
    const hasSignature = (flags & Flag.HasSignature) !== 0;
    const need = V1_HEADER + 8 + (hasRecipient ? 8 : 0) + plen + (hasSignature ? 64 : 0);
    if (raw.length < need) return null;
    const senderId = raw.slice(o, o + 8);
    o += 8;
    let recipientId: Uint8Array | undefined;
    if (hasRecipient) {
      recipientId = raw.slice(o, o + 8);
      o += 8;
    }
    const payload = raw.slice(o, o + plen);
    o += plen;
    let signature: Uint8Array | undefined;
    if (hasSignature) {
      signature = raw.slice(o, o + 64);
      o += 64;
    }
    if (o > raw.length) return null;
    return { version: 1, type, ttl, timestampMs: ts, senderId, recipientId, payload, signature };
  } catch {
    return null;
  }
}

/**
 * Bytes covered by the Ed25519 signature. The spec excludes the TTL byte so
 * relays can decrement it without invalidating the signature — implemented
 * here by forcing TTL=0 and omitting the signature field itself.
 */
export function signingBytes(p: BitPacket): Uint8Array {
  return encodePacket({ ...p, ttl: 0, signature: undefined });
}

export function isBroadcast(p: BitPacket): boolean {
  if (!p.recipientId) return true;
  return p.recipientId.every((b) => b === 0xff);
}

// --- Announce payload (binary identity announcement) ---
export interface Announce {
  peerId: Uint8Array; // 8
  staticPub: Uint8Array; // 32 (Curve25519 Noise static)
  signingPub: Uint8Array; // 32 (Ed25519)
  nick: string;
  timestampMs: number;
  prevPeerId?: Uint8Array; // 8, on identity rotation
}

function lpBytes(b: Uint8Array): Uint8Array {
  if (b.length > 255) throw new Error('field too long');
  return concat(new Uint8Array([b.length]), b);
}

function lpStr(s: string): Uint8Array {
  return lpBytes(new TextEncoder().encode(s));
}

export function encodeAnnounce(a: Announce): Uint8Array {
  if (a.peerId.length !== 8 || a.staticPub.length !== 32 || a.signingPub.length !== 32) {
    throw new Error('bad announce key sizes');
  }
  let flags = 0;
  if (a.prevPeerId) {
    if (a.prevPeerId.length !== 8) throw new Error('prevPeerId must be 8 bytes');
    flags |= 0x01;
  }
  return concat(
    new Uint8Array([flags]),
    a.peerId,
    lpBytes(a.staticPub),
    lpBytes(a.signingPub),
    lpStr(a.nick),
    u64be(a.timestampMs),
    a.prevPeerId ?? new Uint8Array(0)
  );
}

export function decodeAnnounce(raw: Uint8Array): (Announce & { rest: Uint8Array }) | null {
  try {
    let o = 0;
    const rd = (n: number): Uint8Array | null => {
      if (o + n > raw.length) return null;
      const s = raw.slice(o, o + n);
      o += n;
      return s;
    };
    const flagsB = rd(1);
    const peerId = rd(8);
    if (!flagsB || !peerId) return null;
    const flags = flagsB[0];
    const slenB = rd(1);
    if (!slenB) return null;
    const staticPub = rd(slenB[0]);
    const glenB = rd(1);
    if (!staticPub || !glenB) return null;
    const signingPub = rd(glenB[0]);
    const nlenB = rd(1);
    if (!signingPub || !nlenB) return null;
    const nickB = rd(nlenB[0]);
    const tsB = rd(8);
    if (!nickB || !tsB) return null;
    let ts = 0;
    for (const b of tsB) ts = ts * 256 + b;
    let prevPeerId: Uint8Array | undefined;
    if (flags & 0x01) {
      const prev = rd(8);
      if (!prev) return null;
      prevPeerId = prev;
    }
    return {
      peerId,
      staticPub,
      signingPub,
      nick: new TextDecoder().decode(nickB),
      timestampMs: ts,
      prevPeerId,
      rest: raw.slice(o),
    };
  } catch {
    return null;
  }
}

// --- Chat message payload (BitchatMessage) ---
export interface ChatPayload {
  flags: number;
  timestampMs: number;
  id: string; // uuid string
  sender: string; // nickname
  content: string;
  originalSender?: string;
  recipientNick?: string;
}

function enc1(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  if (b.length > 255) throw new Error('field too long');
  return concat(new Uint8Array([b.length]), b);
}

function enc2(s: string): Uint8Array {
  const b = new TextEncoder().encode(s);
  if (b.length > MAX_PAYLOAD) throw new Error('content too long');
  return concat(u16be(b.length), b);
}

export function encodeChatMessage(m: ChatPayload): Uint8Array {
  return concat(
    new Uint8Array([m.flags & 0xff]),
    u64be(m.timestampMs),
    enc1(m.id),
    enc1(m.sender),
    enc2(m.content),
    m.originalSender !== undefined ? enc1(m.originalSender) : new Uint8Array(0),
    m.recipientNick !== undefined ? enc1(m.recipientNick) : new Uint8Array(0)
  );
}

export function decodeChatMessage(raw: Uint8Array): ChatPayload | null {
  try {
    let o = 0;
    const need = (n: number) => {
      if (o + n > raw.length) throw new Error('truncated');
    };
    need(1 + 8);
    const flags = raw[o++];
    let ts = 0;
    for (let i = 0; i < 8; i++) ts = ts * 256 + raw[o++];
    const s1 = (): string => {
      need(1);
      const n = raw[o++];
      need(n);
      const s = new TextDecoder().decode(raw.slice(o, o + n));
      o += n;
      return s;
    };
    const s2 = (): string => {
      need(2);
      const n = (raw[o++] << 8) | raw[o++];
      need(n);
      const s = new TextDecoder().decode(raw.slice(o, o + n));
      o += n;
      return s;
    };
    const id = s1();
    const sender = s1();
    const content = s2();
    const hasOrig = (flags & MsgFlag.HasOriginalSender) !== 0;
    const isPrivate = (flags & MsgFlag.IsPrivate) !== 0;
    const originalSender = hasOrig ? s1() : undefined;
    const recipientNick = isPrivate ? s1() : undefined;
    return { flags, timestampMs: ts, id, sender, content, originalSender, recipientNick };
  } catch {
    return null;
  }
}

// --- Fragment payload, type 0x20 [GM-EXT layout inside the official type] ---
export interface Fragment {
  msgId: Uint8Array; // 16 bytes
  index: number; // u16 BE
  total: number; // u16 BE
  chunk: Uint8Array;
}

export function encodeFragment(f: Fragment): Uint8Array {
  if (f.msgId.length !== 16) throw new Error('msgId must be 16 bytes');
  return concat(f.msgId, u16be(f.index), u16be(f.total), f.chunk);
}

export function decodeFragment(raw: Uint8Array): Fragment | null {
  if (raw.length < 20) return null;
  return {
    msgId: raw.slice(0, 16),
    index: (raw[16] << 8) | raw[17],
    total: (raw[18] << 8) | raw[19],
    chunk: raw.slice(20),
  };
}

/** Split an encoded packet into MTU-fitting fragments (default 512 like the app). */
export function fragmentPacket(encoded: Uint8Array, msgId16: Uint8Array, mtu = BLE_MTU): Uint8Array[] {
  const room = mtu - 20; // fragment header overhead
  const total = Math.max(1, Math.ceil(encoded.length / room));
  const out: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    out.push(encodeFragment({ msgId: msgId16, index: i, total, chunk: encoded.slice(i * room, (i + 1) * room) }));
  }
  return out;
}

/** PKCS#7-style padding to 256/512/1024/2048 buckets — noise packets only (§4). */
export function padNoise(raw: Uint8Array): Uint8Array {
  const buckets = [256, 512, 1024, 2048];
  for (const b of buckets) {
    if (raw.length <= b) {
      const padLen = b - raw.length;
      if (padLen === 0) return raw;
      if (padLen > 255) return raw; // cannot express: emit unpadded per spec
      const out = new Uint8Array(b);
      out.set(raw, 0);
      out.fill(padLen, raw.length);
      return out;
    }
  }
  return raw;
}

/** Peer ID = first 8 bytes of SHA-256(Noise static public key) (§3). */
export function peerIdFromStaticPub(sha256ofStaticPub32: Uint8Array): Uint8Array {
  if (sha256ofStaticPub32.length !== 32) throw new Error('need 32-byte fingerprint');
  return sha256ofStaticPub32.slice(0, 8);
}

export function hex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('');
}

export function unhex(s: string): Uint8Array {
  if (s.length % 2 !== 0) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
