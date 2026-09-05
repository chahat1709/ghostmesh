// App state — zustand store, persisted through src/store/persist (MMKV on
// device, in-memory on web/tests). The mesh itself lives in src/store/mesh.ts;
// this is only the render state it feeds.

import { create } from 'zustand';
import { ChatMessage, Peer, HexPubkey } from '../protocol/types';
import { KEYS, kv, loadJson, saveJson } from './persist';
import { MeshStatus } from './mesh';
import { AVATAR_COLORS } from './mesh';

export { AVATAR_COLORS };

export const DEFAULT_STATUS: MeshStatus = {
  started: false,
  radio: { scan: false, serve: false },
  linkCount: 0,
  bridgeOnline: false,
  outbox: 0,
  peerCount: 0,
  lastError: null,
};

interface ChatState {
  me: { pubkey: HexPubkey; nick: string; color: string } | null;
  tribe: string;
  tribePassword: Record<string, string>;
  messages: Record<string, ChatMessage[]>; // tribe -> msgs
  dms: Record<string, ChatMessage[]>;      // peer pubkey -> msgs
  peers: Record<string, Peer>;
  status: MeshStatus;
  setMe: (m: ChatState['me']) => void;
  setTribe: (t: string) => void;
  setPassword: (tribe: string, pw: string) => void;
  setStatus: (s: MeshStatus) => void;
  pushMsg: (m: ChatMessage) => void;
  pushDm: (peer: string, m: ChatMessage) => void;
  upsertPeer: (p: Peer) => void;
  removePeer: (peer: string) => void;
  /** Drop anything whose burn timer has run out. */
  pruneExpired: (now?: number) => number;
  hydrate: () => void;
  panicWipe: () => void;
}

const CAP = 500;

function alive(list: ChatMessage[], now: number): ChatMessage[] {
  return list.filter((m) => !m.expiresAt || m.expiresAt > now);
}

/** Load persisted state, discarding anything that already burned. */
function initial(): Pick<ChatState, 'me' | 'tribe' | 'tribePassword' | 'messages' | 'dms' | 'peers'> {
  const now = Date.now();
  const messages: Record<string, ChatMessage[]> = {};
  for (const [tribe, list] of Object.entries(loadJson<Record<string, ChatMessage[]>>(KEYS.messages) ?? {})) {
    messages[tribe] = alive(Array.isArray(list) ? list : [], now);
  }
  if (!messages.lobby) messages.lobby = [];
  const dms: Record<string, ChatMessage[]> = {};
  for (const [peer, list] of Object.entries(loadJson<Record<string, ChatMessage[]>>(KEYS.dms) ?? {})) {
    dms[peer] = alive(Array.isArray(list) ? list : [], now);
  }
  return {
    me: loadJson<ChatState['me']>(KEYS.identityUi),
    tribe: loadJson<string>(KEYS.tribe) ?? 'lobby',
    tribePassword: loadJson<Record<string, string>>(KEYS.passwords) ?? {},
    messages,
    dms,
    peers: loadJson<Record<string, Peer>>(KEYS.peers) ?? {},
  };
}

export const useChat = create<ChatState>((set, get) => ({
  ...initial(),
  status: DEFAULT_STATUS,

  setMe: (me) => {
    set({ me });
    if (me) saveJson(KEYS.identityUi, me);
    else kv.del(KEYS.identityUi);
  },
  setTribe: (tribe) => {
    set({ tribe });
    saveJson(KEYS.tribe, tribe);
  },
  setPassword: (tribe, pw) => {
    const next = { ...get().tribePassword, [tribe]: pw };
    set({ tribePassword: next });
    saveJson(KEYS.passwords, next);
  },
  setStatus: (status) => set({ status }),

  pushMsg: (m) =>
    set((s) => {
      const list = [...(s.messages[m.tribe] ?? []), m].slice(-CAP);
      const messages = { ...s.messages, [m.tribe]: list };
      saveJson(KEYS.messages, messages);
      return { messages };
    }),

  pushDm: (peer, m) =>
    set((s) => {
      const dms = { ...s.dms, [peer]: [...(s.dms[peer] ?? []), m].slice(-CAP) };
      saveJson(KEYS.dms, dms);
      return { dms };
    }),

  upsertPeer: (p) =>
    set((s) => {
      const peers = { ...s.peers, [p.pubkey]: p };
      saveJson(KEYS.peers, peers);
      return { peers };
    }),

  removePeer: (peer) =>
    set((s) => {
      if (!s.peers[peer]) return s;
      const peers = { ...s.peers };
      delete peers[peer];
      saveJson(KEYS.peers, peers);
      return { peers };
    }),

  pruneExpired: (now = Date.now()) => {
    const s = get();
    let dropped = 0;
    const messages: Record<string, ChatMessage[]> = {};
    for (const [tribe, list] of Object.entries(s.messages)) {
      const keep = alive(list, now);
      dropped += list.length - keep.length;
      messages[tribe] = keep;
    }
    const dms: Record<string, ChatMessage[]> = {};
    for (const [peer, list] of Object.entries(s.dms)) {
      const keep = alive(list, now);
      dropped += list.length - keep.length;
      dms[peer] = keep;
    }
    if (dropped > 0) {
      saveJson(KEYS.messages, messages);
      saveJson(KEYS.dms, dms);
      set({ messages, dms });
    }
    return dropped;
  },

  hydrate: () => set(initial()),

  panicWipe: () => {
    kv.clearAll();
    set({
      me: null,
      tribe: 'lobby',
      tribePassword: {},
      messages: { lobby: [] },
      dms: {},
      peers: {},
      status: DEFAULT_STATUS,
    });
  },
}));
