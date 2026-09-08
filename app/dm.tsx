// Direct messages — Noise XX end-to-end encrypted, one thread per peer.
// Reached from the radar; the session layer (src/store/mesh.ts) does the
// handshake, the sealing and the store-and-forward when a peer is out of range.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  StyleSheet,
  Alert,
} from 'react-native';
import { Link, useLocalSearchParams } from 'expo-router';
import { useChat } from '../src/store/chatStore';
import { getSession } from '../src/store/sessionHost';
import { DEFAULT_BURN_S } from '../src/store/mesh';

export default function DmScreen() {
  const { peer } = useLocalSearchParams<{ peer: string }>();
  const peerHex = String(peer ?? '');
  const { dms, peers, status } = useChat();
  const [text, setText] = useState('');
  const [burn, setBurn] = useState(false);
  const [hint, setHint] = useState('');
  const listRef = useRef<FlatList<any>>(null);

  const thread = useMemo(() => dms[peerHex] ?? [], [dms, peerHex]);
  const nick = peers[peerHex]?.nick ?? peerHex.slice(0, 6);

  useEffect(() => {
    if (thread.length) listRef.current?.scrollToEnd({ animated: false });
  }, [thread.length]);

  const send = () => {
    const body = text.trim();
    const session = getSession();
    if (!body || !session) {
      if (!session) Alert.alert('Mesh not running', 'Go back and enter the mesh first.');
      return;
    }
    setText('');
    const res = session.sendDm(peerHex, burn ? `[#burn:${DEFAULT_BURN_S}] ${body}` : body);
    if (res.handshaking) {
      setHint('Opening an encrypted session… the message goes out as soon as they answer.');
    } else if (res.queued) {
      setHint('Out of range — held in the courier outbox, delivered on next contact.');
    } else {
      setHint('');
    }
  };

  /** Send the composed text as a real chunked file transfer. */
  const sendAsFile = () => {
    const body = text.trim();
    const session = getSession();
    if (!body || !session) return;
    setText('');
    const bytes = new TextEncoder().encode(body);
    const n = session.sendFile(peerHex, `ghost-${Date.now()}.txt`, bytes);
    setHint(`Sent as ${n} file chunk${n === 1 ? '' : 's'}.`);
  };

  return (
    <View style={s.root}>
      <View style={s.header}>
        <Link href="/" asChild>
          <Pressable style={s.back}><Text style={s.backTxt}>← back</Text></Pressable>
        </Link>
        <Text style={s.title}>🔒 {nick}</Text>
      </View>
      {status?.lastError ? <Text style={s.err}>⚠ {status.lastError}</Text> : null}
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
      <FlatList
        ref={listRef}
        data={thread}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ListEmptyComponent={
          <Text style={s.empty}>
            No messages yet.{'\n'}The first send opens a Noise XX handshake — keys never leave either phone.
          </Text>
        }
        renderItem={({ item }) => (
          <View style={[s.bubble, item.mine && s.mine]}>
            <Text style={s.meta}>{item.mine ? 'you' : nick} · {item.expiresAt ? '💨 burns' : '✓ sealed'}</Text>
            <Text style={s.body}>{item.text}</Text>
          </View>
        )}
      />
      <View style={s.composer}>
        <TextInput
          style={s.input}
          placeholder={`DM ${nick}…`}
          placeholderTextColor="#666"
          value={text}
          onChangeText={setText}
          onSubmitEditing={send}
          returnKeyType="send"
        />
        <Pressable
          style={[s.chip, burn && s.chipOn]}
          onPress={() => setBurn((b) => !b)}
        >
          <Text style={[s.chipTxt, burn && s.chipTxtOn]}>💨 {DEFAULT_BURN_S}s</Text>
        </Pressable>
        <Pressable style={s.attach} onPress={sendAsFile}><Text style={s.btnTxt}>📎</Text></Pressable>
        <Pressable style={s.send} onPress={send}><Text style={s.btnTxt}>➤</Text></Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0b12' },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  back: { backgroundColor: '#17171f', padding: 8, borderRadius: 8 },
  backTxt: { color: '#06b6d4', fontWeight: '800' },
  title: { color: '#fff', fontWeight: '900' },
  err: { color: '#f59e0b', paddingHorizontal: 12, paddingBottom: 6, fontWeight: '700' },
  hint: { color: '#8b5cf6', paddingHorizontal: 12, paddingBottom: 6 },
  input: { flex: 1, backgroundColor: '#17171f', color: '#fff', borderRadius: 12, padding: 12 },
  bubble: { backgroundColor: '#17171f', borderRadius: 12, padding: 10 },
  mine: { backgroundColor: '#241b3d', borderColor: '#8b5cf6', borderWidth: 1 },
  meta: { color: '#888', fontSize: 11, marginBottom: 4, fontWeight: '700' },
  body: { color: '#fff', fontSize: 15, lineHeight: 21 },
  composer: { flexDirection: 'row', gap: 8, padding: 12, alignItems: 'center' },
  send: { backgroundColor: '#8b5cf6', borderRadius: 12, width: 48, height: 44, alignItems: 'center', justifyContent: 'center' },
  attach: { backgroundColor: '#17171f', borderRadius: 12, width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  chip: { backgroundColor: '#17171f', borderRadius: 999, paddingHorizontal: 10, height: 32, alignItems: 'center', justifyContent: 'center' },
  chipOn: { backgroundColor: '#8b5cf6' },
  chipTxt: { color: '#999', fontWeight: '800' },
  chipTxtOn: { color: '#fff' },
  btnTxt: { color: '#fff', fontWeight: '900' },
  empty: { color: '#555', textAlign: 'center', marginTop: 60, lineHeight: 24 },
});
