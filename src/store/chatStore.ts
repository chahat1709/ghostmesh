// App state — zustand store. Tribes + DMs + peers + outbox.
// On device this is backed by MMKV (src/store/persist.ts); the store hydrates
// from it on launch and writes through on every mutation, so a relaunch keeps
// history, tribe passwords and the courier outbox.
import { create } from 'zustand';
import { ChatMessage, Peer, HexPubkey } from '../protocol/types';
import { getKv } from './persist';
import type { MeshStatus } from './mesh';

const K_MESSAGES = 'messages';
const K_DMS = 'dms';
const K_TRIBE = 'tribe';

export interface ChatState {
  me: { pubkey: HexPubkey; nick: string; color: string } | null;
  tribe: string;
  tribePassword: Record<string, string>;
  messages: Record<string, ChatMessage[]>; // tribe -> msgs
  dms: Record<string, ChatMessage[]>;      // peer pubkey -> msgs
  peers: Record<string, Peer>;
  online: boolean;
  status: MeshStatus | null;
  setMe: (m: ChatState['me']) => void;
  setTribe: (t: string) => void;
  setPassword: (tribe: string, pw: string) => void;
  pushMsg: (m: ChatMessage) => void;
  pushDm: (peer: string, m: ChatMessage) => void;
  upsertPeer: (p: Peer) => void;
  removePeer: (pubkey: HexPubkey) => void;
  setStatus: (s: MeshStatus | null) => void;
  setOnline: (v: boolean) => void;
  /** Drop messages whose burn timer has elapsed. */
  pruneExpired: (now?: number) => void;
  /** Load persisted state. Called once on app start. */
  hydrate: () => void;
  panicWipe: () => void;
}

export const AVATAR_COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899'];

const MSG_CAP = 500;

function save(key: string, value: unknown): void {
  try {
    getKv().set(key, JSON.stringify(value));
  } catch {
    /* storage full / unavailable — never break the UI */
  }
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = getKv().get(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function prune(list: ChatMessage[], now: number): ChatMessage[] {
  return list.filter((m) => !m.expiresAt || m.expiresAt > now);
}

export const useChat = create<ChatState>((set, get) => ({
  me: null,
  tribe: 'lobby',
  tribePassword: {},
  messages: { lobby: [] },
  dms: {},
  peers: {},
  online: false,
  status: null,

  setMe: (me) => set({ me }),

  setTribe: (tribe) => {
    save(K_TRIBE, tribe);
    set({ tribe });
  },

  setPassword: (tribe, pw) =>
    set((s) => {
      const tribePassword = { ...s.tribePassword, [tribe]: pw };
      save('tribePasswords', tribePassword);
      return { tribePassword };
    }),

  pushMsg: (m) =>
    set((s) => {
      const list = [...(s.messages[m.tribe] ?? []), m].slice(-MSG_CAP);
      const messages = { ...s.messages, [m.tribe]: list };
      save(K_MESSAGES, messages);
      return { messages };
    }),

  pushDm: (peer, m) =>
    set((s) => {
      const dms = { ...s.dms, [peer]: [...(s.dms[peer] ?? []), m].slice(-MSG_CAP) };
      save(K_DMS, dms);
      return { dms };
    }),

  upsertPeer: (p) => set((s) => ({ peers: { ...s.peers, [p.pubkey]: p } })),

  removePeer: (pubkey) =>
    set((s) => {
      const peers = { ...s.peers };
      delete peers[pubkey];
      return { peers };
    }),

  setStatus: (status) => set({ status }),

  setOnline: (online) => set({ online }),

  pruneExpired: (now = Date.now()) =>
    set((s) => {
      const messages: Record<string, ChatMessage[]> = {};
      let changed = false;
      for (const [tribe, list] of Object.entries(s.messages)) {
        const kept = prune(list, now);
        messages[tribe] = kept;
        if (kept.length !== list.length) changed = true;
      }
      const dms: Record<string, ChatMessage[]> = {};
      for (const [peer, list] of Object.entries(s.dms)) {
        const kept = prune(list, now);
        dms[peer] = kept;
        if (kept.length !== list.length) changed = true;
      }
      if (!changed) return {};
      save(K_MESSAGES, messages);
      save(K_DMS, dms);
      return { messages, dms };
    }),

  hydrate: () => {
    const kv = getKv();
    const messages = load<Record<string, ChatMessage[]>>(K_MESSAGES, { lobby: [] });
    if (!messages.lobby) messages.lobby = [];
    const dms = load<Record<string, ChatMessage[]>>(K_DMS, {});
    const tribe = kv.get(K_TRIBE) ?? 'lobby';
    const tribePassword = load<Record<string, string>>('tribePasswords', {});
    const now = Date.now();
    // Expire anything that should have burned while we were closed.
    for (const k of Object.keys(messages)) messages[k] = prune(messages[k], now);
    for (const k of Object.keys(dms)) dms[k] = prune(dms[k], now);
    save(K_MESSAGES, messages);
    save(K_DMS, dms);
    set({ messages, dms, tribe, tribePassword });
  },

  panicWipe: () => {
    try {
      getKv().clearAll();
    } catch {}
    set({
      messages: { lobby: [] },
      dms: {},
      peers: {},
      me: null,
      tribePassword: {},
      status: null,
    });
  },
}));
