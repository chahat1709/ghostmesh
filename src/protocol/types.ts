// GhostMesh protocol v1 — types shared by mobile (BLE) + web (simulated transport).
// Different from bitchat: identity-based, typed packets, adaptive TTL, tribes, receipts.

export type HexPubkey = string; // 64 hex chars (ed25519 pubkey)

export type PacketKind =
  | 'announce'   // hello, I'm here: {nick, color, karma}
  | 'msg'        // tribe / public message
  | 'dm'         // E2E encrypted direct message
  | 'dm Invite'  // X25519 handshake invite — actually 'dm-invite'
  | 'ack'        // delivery receipt
  | 'chunk'      // file/image fragment
  | 'relayStats';// karma gossip

// Fix: 'dm Invite' typo guard — canonical kinds below
export type WireKind = 'announce' | 'msg' | 'dm' | 'dm-invite' | 'ack' | 'chunk' | 'relayStats';

export interface WirePacket {
  v: 1;
  id: string;          // 16 hex chars, dedupe key
  kind: WireKind;
  from: HexPubkey;     // sender identity
  to?: HexPubkey | string; // DM target pubkey or tribe name
  tribe?: string;      // e.g. 'lobby' | 'ballers' — undefined = dm/announce
  ttl: number;         // hops remaining 0..7
  ts: number;          // epoch ms
  hops: HexPubkey[];   // path for loop prevention + radar map
  body: any;           // kind-specific payload (encrypted for dm)
  sig: string;         // ed25519 signature over canonical bytes (hex)
}

export interface ChatMessage {
  id: string;
  tribe: string;
  from: HexPubkey;
  nick: string;
  color: string;
  text: string;
  ts: number;
  hops: number;
  mine: boolean;
  verified: boolean;
  replyTo?: string;
  expiresAt?: number; // disappearing messages
  reactions?: Record<string, number>;
}

export interface Peer {
  pubkey: HexPubkey;
  nick: string;
  color: string;
  rssi: number;        // -30 (close) .. -95 (far)
  lastSeen: number;
  hopsAway: number;    // 1 = direct, >1 via relay
  karma: number;       // relay score
  via?: HexPubkey;     // relay node if indirect
}

export const TRIBES = ['lobby', 'ballers', 'music', 'trade', 'afterparty'] as const;
export type Tribe = (typeof TRIBES)[number];

export const MAX_TTL = 7;
export const MSG_TTL_MS = 7 * 24 * 3600 * 1000; // 7-day store-forward
export const CHUNK_SIZE = 3800; // fits in one BLE extended advertisement / GATT write
