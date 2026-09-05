// Direct messages — Noise XX when a live session exists, Noise X courier
// seals (queued in the 7-day outbox) when the peer is out of range.
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList, StyleSheet } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useChat } from '../src/store/chatStore';
import { getSession } from '../src/store/sessionHost';
import { DEFAULT_BURN_S } from '../src/store/mesh';

export default function DmScreen() {
  const { peer } = useLocalSearchParams<{ peer: string }>();
  const peerHex = String(peer ?? '');
  const { dms, peers, pruneExpired } = useChat();
  const [text, setText] = useState('');
  const [burn, setBurn] = useState(false);
  const [mode, setMode] = useState<string>('idle');

  const thread = useMemo(() => dms[peerHex] ?? [], [dms, peerHex]);
  const nick = peers[peerHex]?.nick ?? peerHex.slice(0, 6);

  useEffect(() => {
    const id = setInterval(() => pruneExpired(), 1000);
    return () => clearInterval(id);
  }, [pruneExpired]);

  // Opportunistic handshake: if we can hear them, negotiate XX so later
  // messages get forward secrecy instead of courier seals.
  useEffect(() => {
    const session = getSession();
    if (!session || !peerHex) return;
    if (!session.dm.ready(peerHex) && peers[peerHex]) {
      session.beginHandshake(peerHex);
    }
    const tick = setInterval(() => {
      setMode(session.dm.ready(peerHex) ? 'Noise XX live · forward-secret' : 'Noise X courier seals');
    }, 1500);
    setMode(session.dm.ready(peerHex) ? 'Noise XX live · forward-secret' : 'Noise X courier seals');
    return () => clearInterval(tick);
  }, [peerHex, peers]);

  const send = () => {
    const session = getSession();
    const body = text.trim();
    if (!session || !body) return;
    setText('');
    const res = session.sendDm(peerHex, body, { burnSeconds: burn ? DEFAULT_BURN_S : 0 });
    if (!res) return;
    setMode(
      res.mode === 'xx'
        ? 'sent over Noise XX session'
        : res.mode === 'courier'
          ? 'sent as Noise X courier seal'
          : 'queued — will deliver when they appear'
    );
  };

  return (
    <View style={s.root}>
      <View style={s.head}>
        <Text style={s.title}>{nick}</Text>
        <Text style={s.mode}>{mode}</Text>
        <Text style={s.id}>{peerHex}</Text>
      </View>
      <FlatList
        data={thread}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ListEmptyComponent={<Text style={s.empty}>No messages yet. DMs are end-to-end: Noise XX with forward secrecy when you can hear each other, sealed courier mail when you can't.</Text>}
        renderItem={({ item }) => (
          <View style={[s.bubble, item.mine && s.mine]}>
            <Text style={s.meta}>
              {item.mine ? 'me' : item.nick} · {item.hops === 0 ? 'direct' : `${item.hops} hops`}
              {item.expiresAt ? ` · 🔥 ${Math.max(0, Math.round((item.expiresAt - Date.now()) / 1000))}s` : ''}
            </Text>
            <Text style={s.body}>{item.text}</Text>
          </View>
        )}
      />
      <View style={s.composer}>
        <Pressable style={[s.tool, burn && s.toolOn]} onPress={() => setBurn(!burn)}><Text style={{ fontSize: 16 }}>🔥</Text></Pressable>
        <TextInput style={s.input} placeholder={`message ${nick}…`} placeholderTextColor="#666" value={text} onChangeText={setText} onSubmitEditing={send} returnKeyType="send" />
        <Pressable style={s.send} onPress={send}><Text style={s.btnText}>➤</Text></Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0b12' },
  head: { padding: 12, borderBottomWidth: 1, borderBottomColor: '#17171f' },
  title: { color: '#fff', fontSize: 18, fontWeight: '900' },
  mode: { color: '#10b981', fontSize: 11, fontWeight: '700', marginTop: 2 },
  id: { color: '#555', fontSize: 10, marginTop: 2 },
  empty: { color: '#555', textAlign: 'center', marginTop: 40, lineHeight: 22, paddingHorizontal: 16 },
  bubble: { backgroundColor: '#17171f', borderRadius: 12, padding: 10 },
  mine: { backgroundColor: '#241b3d', borderColor: '#8b5cf6', borderWidth: 1 },
  meta: { color: '#888', fontSize: 11, marginBottom: 4, fontWeight: '700' },
  body: { color: '#fff', fontSize: 15, lineHeight: 21 },
  composer: { flexDirection: 'row', gap: 8, padding: 12, alignItems: 'center' },
  tool: { backgroundColor: '#17171f', borderRadius: 12, width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  toolOn: { backgroundColor: '#3a1d1d', borderWidth: 1, borderColor: '#ef4444' },
  input: { backgroundColor: '#17171f', color: '#fff', borderRadius: 12, padding: 12, flex: 1 },
  send: { backgroundColor: '#8b5cf6', borderRadius: 12, width: 48, height: 44, alignItems: 'center', justifyContent: 'center' },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
});
