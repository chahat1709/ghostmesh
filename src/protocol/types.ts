// GhostMesh protocol v1 — types shared by mobile (BLE) + web (simulated transport).
// Different from bitchat: identity-based, typed packets, adaptive TTL, tribes, receipts.

export type HexPubkey = string; // 64 hex chars (ed25519 pubkey)

// Wire framing lives in src/protocol/bitchat.ts (real BitChat v1 packets).
// The JSON `WirePacket` shape that used to sit here was never used by the
// encoder or the decoder — only the binary format goes over the air.

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

export const MSG_TTL_MS = 7 * 24 * 3600 * 1000; // 7-day store-forward
