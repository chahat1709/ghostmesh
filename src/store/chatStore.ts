// App state — zustand store. Tribes + DMs + peers + outbox, persisted to MMKV on device.
import { create } from 'zustand';
import { ChatMessage, Peer, HexPubkey } from '../protocol/types';

interface ChatState {
  me: { pubkey: HexPubkey; nick: string; color: string } | null;
  tribe: string;
  tribePassword: Record<string, string>;
  messages: Record<string, ChatMessage[]>; // tribe -> msgs
  dms: Record<string, ChatMessage[]>;      // peer pubkey -> msgs
  peers: Record<string, Peer>;
  online: boolean;
  setMe: (m: ChatState['me']) => void;
  setTribe: (t: string) => void;
  setPassword: (tribe: string, pw: string) => void;
  pushMsg: (m: ChatMessage) => void;
  pushDm: (peer: string, m: ChatMessage) => void;
  upsertPeer: (p: Peer) => void;
  panicWipe: () => void;
}

export const AVATAR_COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899'];

export const useChat = create<ChatState>((set) => ({
  me: null,
  tribe: 'lobby',
  tribePassword: {},
  messages: { lobby: [] },
  dms: {},
  peers: {},
  online: false,
  setMe: (me) => set({ me }),
  setTribe: (tribe) => set({ tribe }),
  setPassword: (tribe, pw) => set((s) => ({ tribePassword: { ...s.tribePassword, [tribe]: pw } })),
  pushMsg: (m) =>
    set((s) => {
      const list = [...(s.messages[m.tribe] ?? []), m].slice(-500);
      return { messages: { ...s.messages, [m.tribe]: list } };
    }),
  pushDm: (peer, m) =>
    set((s) => ({ dms: { ...s.dms, [peer]: [...(s.dms[peer] ?? []), m].slice(-500) } })),
  upsertPeer: (p) => set((s) => ({ peers: { ...s.peers, [p.pubkey]: p } })),
  panicWipe: () => set({ messages: { lobby: [] }, dms: {}, peers: {}, me: null }),
}));
