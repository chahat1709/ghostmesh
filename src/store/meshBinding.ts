// Binds a MeshSession to the zustand store. Kept separate from mesh.ts so the
// mesh controller stays framework-free and unit-testable in plain node.

import { MeshSession } from './mesh';
import { useChat } from './chatStore';

export function bindSession(session: MeshSession): MeshSession {
  session.setHandlers({
    onMessage: (m) => useChat.getState().pushMsg(m),
    onDm: (peer, m) => useChat.getState().pushDm(peer, m),
    onPeer: (p) => useChat.getState().upsertPeer(p),
    onPeerGone: (peer) => useChat.getState().removePeer(peer),
    onStatus: (s) => useChat.getState().setStatus(s),
    onError: (err) => {
      if (__DEV__) console.warn('[mesh]', String((err as Error)?.message ?? err));
    },
  });
  return session;
}
