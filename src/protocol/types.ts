// GhostMesh protocol v1 — types shared by mobile (BLE) + web (simulated transport).
// Wire framing itself lives in src/protocol/bitchat.ts (real BitChat v1 packets);
// these are the app-level shapes the UI renders.
//
// History note: this file used to carry a parallel `WirePacket`/`PacketKind`
// JSON protocol (including a `'dm Invite'` typo) from before the port to real
// BitChat binary framing. Those types had no readers anywhere in the repo, so
// they were removed — the binary codec is the only wire format now.

export type HexPubkey = string; // 16 hex chars (8-byte BitChat peer id) or 64 (ed25519)

export interface ChatMessage {
  id: string;
  tribe: string; // 'lobby' | 'ballers' | … | 'dm'
  from: HexPubkey;
  nick: string;
  color: string;
  text: string;
  ts: number;
  hops: number; // derived from TTL decay at receipt; 0 = direct/own
  mine: boolean;
  verified: boolean; // Ed25519 signature checked
  replyTo?: string;
  expiresAt?: number; // burn-after: epoch ms, pruned by chatStore.pruneExpired
  reactions?: Record<string, number>;
}

export interface Peer {
  pubkey: HexPubkey;
  nick: string;
  color: string;
  rssi: number;        // -30 (close) .. -95 (far), from the radio
  lastSeen: number;    // epoch ms — peers past MeshSession.peerTimeoutMs are dropped
  hopsAway: number;    // 1 = direct, >1 via relay
  karma: number;       // relay reputation (frames this ghost delivered us)
  via?: HexPubkey;     // relay node if indirect
}

export const TRIBES = ['lobby', 'ballers', 'music', 'trade', 'afterparty'] as const;
export type Tribe = (typeof TRIBES)[number];

/** Store-and-forward window for courier mail held for offline peers. */
export const MSG_TTL_MS = 7 * 24 * 3600 * 1000; // 7 days
