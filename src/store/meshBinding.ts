/**
 * Wires a MeshSession to the zustand store.
 *
 * The app's own onPacket keeps handling announces and public messages; this
 * binding only receives what the session owns (DMs, files, status, errors).
 */
import { AVATAR_COLORS, useChat } from './chatStore';
import { MeshSession } from './mesh';
import { parseBurn } from './mesh';
import { hex } from '../protocol/bitchat';

function colorFor(peerHex: string): string {
  let n = 0;
  for (let i = 0; i < peerHex.length; i++) n = (n * 31 + peerHex.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[n % AVATAR_COLORS.length];
}

let pruneTimer: any = null;

export function bindSession(session: MeshSession): () => void {
  const store = useChat.getState();

  session.setHandlers({
    onDm: (peerHex, text, mine) => {
      const { seconds, body } = parseBurn(text);
      useChat.getState().pushDm(peerHex, {
        id: `${peerHex}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        tribe: '',
        from: mine ? session.identity.peerIdHex : peerHex,
        nick: mine ? session.identity.nick : peerHex.slice(0, 6),
        color: mine ? session.identity.color : colorFor(peerHex),
        text: body,
        ts: Date.now(),
        hops: 1,
        mine,
        verified: true,
        expiresAt: seconds ? Date.now() + seconds * 1000 : undefined,
      });
    },
    onFile: (file, fromPeerHex) => {
      // Surface an incoming file as a DM row so it is visible in the thread.
      useChat.getState().pushDm(fromPeerHex, {
        id: `file:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        tribe: '',
        from: fromPeerHex,
        nick: fromPeerHex.slice(0, 6),
        color: colorFor(fromPeerHex),
        text: `📎 ${file.name} (${file.bytes.length} bytes)`,
        ts: Date.now(),
        hops: 1,
        mine: false,
        verified: true,
      });
    },
    onStatus: (status) => useChat.getState().setStatus(status),
    onError: (message) =>
      useChat
        .getState()
        .setStatus({ ...(useChat.getState().status as any), lastError: message } as any),
  });

  store.setStatus(session.getStatus());

  // Burn timers only advance on a wall clock; re-check once a second.
  if (pruneTimer == null) {
    pruneTimer = setInterval(() => useChat.getState().pruneExpired(), 1000);
  }

  return () => {
    session.setHandlers({});
    if (pruneTimer != null) {
      clearInterval(pruneTimer);
      pruneTimer = null;
    }
  };
}

export { hex };
