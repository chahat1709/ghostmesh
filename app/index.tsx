// GhostMesh main screen — dark cyber UI (deliberately NOT bitchat's terminal green).
// Radio layer is real BitChat tech: binary v1 packets, TTL-7 flood, Ed25519
// announces, Noise XX DMs, courier outbox, chunked files, bridge uplink.
// Tribes ride as `(#name)` prefixes [GM-EXT]. Triple-tap the logo = panic wipe.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList, StyleSheet, Alert, ScrollView } from 'react-native';
import { Link, router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { useChat, AVATAR_COLORS } from '../src/store/chatStore';
import { bindSession } from '../src/store/meshBinding';
import { getSession, setSession } from '../src/store/sessionHost';
import {
  DEFAULT_BURN_S,
  MeshSession,
  createIdentity,
  loadIdentity,
} from '../src/store/mesh';
import { TRIBES } from '../src/protocol/types';
import * as Application from 'expo-application';
import { checkForApkUpdate, downloadAndInstall } from '../src/updates/selfUpdate';

/** Boot the mesh: restore the saved identity or create one, then start radio. */
async function bootMesh(nick?: string): Promise<MeshSession | null> {
  try {
    const existing = loadIdentity();
    const identity =
      existing ??
      createIdentity(nick || `ghost-${Math.random().toString(16).slice(2, 6)}`, AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)]);
    if (nick && existing && nick !== existing.nick) identity.nick = nick.slice(0, 18);
    const session = bindSession(new MeshSession({ identity }));
    setSession(session);
    await session.start();
    return session;
  } catch (err) {
    Alert.alert('Could not enter the mesh', String((err as Error)?.message ?? err));
    return null;
  }
}

export default function Home() {
  const {
    me, setMe, tribe, setTribe, messages, peers, tribePassword, setPassword,
    status, pruneExpired, panicWipe,
  } = useChat();
  const [nick, setNick] = useState('');
  const [text, setText] = useState('');
  const [tapCount, setTapCount] = useState(0);
  const [burn, setBurn] = useState(false);
  const [attach, setAttach] = useState(false);
  const [fileName, setFileName] = useState('note.txt');
  const [fileBody, setFileBody] = useState('');
  const [pwFor, setPwFor] = useState<string | null>(null);
  const [pwDraft, setPwDraft] = useState('');
  const inputRef = useRef<TextInput>(null);
  const [update, setUpdate] = useState<{ tag: string; url: string } | null>(null);
  const [dlProgress, setDlProgress] = useState<number | null>(null);

  // self-update check (GitHub releases) — silent unless an update exists
  useEffect(() => {
    (async () => {
      try {
        const info = await checkForApkUpdate(Application.nativeBuildVersion ?? '1');
        if (info) setUpdate({ tag: info.tag, url: info.url });
      } catch {}
    })();
  }, []);

  // restore a previous ghost on relaunch (identity + messages come from MMKV)
  useEffect(() => {
    if (me || getSession()) return;
    const saved = loadIdentity();
    if (!saved) return;
    void (async () => {
      setMe({ pubkey: saved.peerIdHex, nick: saved.nick, color: saved.color });
      const s = await bootMesh();
      if (s) useChat.getState().hydrate();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // burn timers need a tick to actually disappear
  useEffect(() => {
    const id = setInterval(() => pruneExpired(), 1000);
    return () => clearInterval(id);
  }, [pruneExpired]);

  const installUpdate = async () => {
    if (!update || dlProgress !== null) return;
    try {
      setDlProgress(0);
      await downloadAndInstall(update.url, setDlProgress);
    } catch {
      setDlProgress(null);
      Alert.alert('Update failed', 'Could not download the update. The mesh still works — try again on Wi-Fi.');
    }
  };

  // --- onboarding identity (dual BitChat keys, §3) ---
  if (!me) {
    return (
      <View style={s.center}>
        <Text style={s.logo}>◈ GhostMesh</Text>
        <Text style={s.sub}>off-grid · encrypted · no servers</Text>
        <TextInput style={s.input} placeholder="pick a nickname" placeholderTextColor="#666" value={nick} onChangeText={setNick} maxLength={18} />
        <Pressable
          style={s.btn}
          onPress={() => {
            void (async () => {
              const session = await bootMesh(nick.trim());
              if (!session) return;
              setMe({ pubkey: session.identity.peerIdHex, nick: session.identity.nick, color: session.identity.color });
              Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
            })();
          }}
        >
          <Text style={s.btnText}>enter the mesh →</Text>
        </Pressable>
        <Text style={s.hint}>
          Real BitChat radio: binary mesh packets + Noise DMs + tribes + radar. Nothing leaves your phone except signed radio frames.
        </Text>
        {update && (
          <Pressable style={[s.updateBar, { width: '100%' }]} onPress={installUpdate}>
            <Text style={s.updateTxt}>
              {dlProgress === null ? `⬆ ${update.tag} ready — tap to update` : `⬇ downloading… ${Math.round(dlProgress * 100)}%`}
            </Text>
          </Pressable>
        )}
      </View>
    );
  }

  const feed = useMemo(() => messages[tribe] ?? [], [messages, tribe]);
  const ghostList = useMemo(() => Object.values(peers).sort((a, b) => b.rssi - a.rssi), [peers]);

  const sendMsg = () => {
    const body = text.trim();
    const session = getSession();
    if (!body || !session) return;
    setText('');
    session.postTribe(tribe, body, {
      password: tribePassword[tribe],
      burnSeconds: burn ? DEFAULT_BURN_S : 0,
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const sendAttachment = () => {
    const session = getSession();
    const body = fileBody.trim();
    if (!session || !body) return;
    const bytes = new Uint8Array(body.length);
    for (let i = 0; i < body.length; i++) bytes[i] = body.charCodeAt(i) & 0xff;
    const n = session.sendFile(fileName.trim() || 'note.txt', bytes, 0x01);
    setFileBody('');
    setAttach(false);
    Alert.alert('Sent', `${n} chunk${n === 1 ? '' : 's'} on the mesh (type 0x22).`);
  };

  const exportTribe = async () => {
    const session = getSession();
    if (!session) return;
    try {
      const txt = session.exportTranscript(tribe, feed);
      const uri = `${FileSystem.cacheDirectory ?? ''}ghostmesh-${tribe}.txt`;
      await FileSystem.writeAsStringAsync(uri, txt);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(uri);
      else Alert.alert('Exported', uri);
    } catch (err) {
      Alert.alert('Export failed', String((err as Error)?.message ?? err));
    }
  };

  const onLogoTap = () => {
    const n = tapCount + 1;
    setTapCount(n);
    if (n >= 3) {
      setTapCount(0);
      Alert.alert('Panic wipe?', 'Deletes identity, keys, messages and peers from this device.', [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'WIPE',
          style: 'destructive',
          onPress: () => {
            getSession()?.wipe();
            setSession(null);
            panicWipe();
          },
        },
      ]);
    }
    setTimeout(() => setTapCount(0), 1200);
  };

  const radioLabel = status.radio.scan ? (status.radio.serve ? 'central + peripheral' : 'central only') : 'no radio';

  return (
    <View style={s.root}>
      <Pressable onPress={onLogoTap}>
        <View style={s.header}>
          <Text style={s.logoSm}>◈ GhostMesh</Text>
          <Text style={s.peerCount}>{Object.keys(peers).length} nearby · {radioLabel}</Text>
          <Pressable style={s.radarBtn} onPress={exportTribe}><Text style={s.radarTxt}>export</Text></Pressable>
          <Link href="/radar" asChild><Pressable style={s.radarBtn}><Text style={s.radarTxt}>radar →</Text></Pressable></Link>
        </View>
      </Pressable>
      {update && (
        <Pressable style={s.updateBar} onPress={installUpdate}>
          <Text style={s.updateTxt}>
            {dlProgress === null ? `⬆ ${update.tag} ready — tap to update` : `⬇ downloading… ${Math.round(dlProgress * 100)}%`}
          </Text>
        </Pressable>
      )}
      <View style={s.tribes}>
        {TRIBES.map((t) => (
          <Pressable key={t} onPress={() => setTribe(t)} onLongPress={() => { setPwFor(t); setPwDraft(tribePassword[t] ?? ''); }} style={[s.tribe, tribe === t && s.tribeOn]}>
            <Text style={[s.tribeTxt, tribe === t && s.tribeTxtOn]}>#{t}{tribePassword[t] ? ' 🔒' : ''}</Text>
          </Pressable>
        ))}
      </View>
      {pwFor && (
        <View style={s.pwRow}>
          <TextInput style={[s.input, { flex: 1 }]} placeholder={`password for #${pwFor}`} placeholderTextColor="#666" value={pwDraft} onChangeText={setPwDraft} autoCapitalize="none" />
          <Pressable style={s.send} onPress={() => { const t = pwFor; setPwFor(null); if (t) { setPassword(t, pwDraft); getSession()?.setPassword(t, pwDraft); } }}>
            <Text style={s.btnText}>✓</Text>
          </Pressable>
        </View>
      )}
      {ghostList.length > 0 && (
        <ScrollView horizontal style={{ maxHeight: 44 }} contentContainerStyle={{ paddingHorizontal: 12, gap: 6 }} showsHorizontalScrollIndicator={false}>
          {ghostList.map((p) => (
            <Pressable key={p.pubkey} style={s.ghost} onPress={() => router.push(`/dm?peer=${p.pubkey}`)}>
              <Text style={{ color: p.color, fontWeight: '900' }}>●</Text>
              <Text style={s.ghostTxt}>{p.nick}</Text>
            </Pressable>
          ))}
        </ScrollView>
      )}
      <FlatList
        data={feed}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ListEmptyComponent={<Text style={s.empty}>Silent… be the first ghost in #{tribe}.{'\n'}Messages hop phone-to-phone, no internet needed.</Text>}
        renderItem={({ item }) => (
          <View style={[s.bubble, item.mine && s.mine]}>
            <Text style={s.meta}>
              <Text style={{ color: item.color }}>●</Text> {item.nick} · {item.hops === 0 ? 'direct' : `${item.hops} hops`} {item.verified ? '✓' : '⚠'}
              {item.expiresAt ? ` · 🔥 ${Math.max(0, Math.round((item.expiresAt - Date.now()) / 1000))}s` : ''}
            </Text>
            <Text style={s.body}>{item.text}</Text>
          </View>
        )}
      />
      {attach && (
        <View style={s.attach}>
          <TextInput style={[s.input, { marginBottom: 6 }]} placeholder="file name" placeholderTextColor="#666" value={fileName} onChangeText={setFileName} />
          <TextInput style={[s.input, { height: 72, textAlignVertical: 'top' }]} placeholder="paste the bytes/text to send…" placeholderTextColor="#666" value={fileBody} onChangeText={setFileBody} multiline />
          <Text style={s.attachHint}>Sent as chunked type-0x22 frames (≤414B each), reassembled by receivers.</Text>
        </View>
      )}
      <View style={s.composer}>
        <Pressable style={s.tool} onPress={() => setAttach(!attach)}><Text style={s.toolTxt}>📎</Text></Pressable>
        <Pressable style={[s.tool, burn && s.toolOn]} onPress={() => setBurn(!burn)}><Text style={s.toolTxt}>🔥</Text></Pressable>
        <TextInput ref={inputRef} style={s.input} placeholder={`message #${tribe}…`} placeholderTextColor="#666" value={text} onChangeText={setText} onSubmitEditing={sendMsg} returnKeyType="send" />
        <Pressable style={s.send} onPress={sendMsg}><Text style={s.btnText}>➤</Text></Pressable>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0b12' },
  center: { flex: 1, backgroundColor: '#0b0b12', alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  logo: { color: '#fff', fontSize: 42, fontWeight: '900' },
  logoSm: { color: '#fff', fontSize: 20, fontWeight: '900' },
  sub: { color: '#8b5cf6', fontWeight: '700' },
  hint: { color: '#666', textAlign: 'center', marginTop: 12, lineHeight: 20 },
  input: { backgroundColor: '#17171f', color: '#fff', borderRadius: 12, padding: 12, flex: 1 },
  btn: { backgroundColor: '#8b5cf6', borderRadius: 12, padding: 14, width: '100%', alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12 },
  peerCount: { color: '#10b981', fontWeight: '700', fontSize: 11 },
  radarBtn: { marginLeft: 6, backgroundColor: '#17171f', padding: 8, borderRadius: 8 },
  radarTxt: { color: '#06b6d4', fontWeight: '800' },
  tribes: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  updateBar: { marginHorizontal: 12, marginBottom: 8, backgroundColor: '#10b981', borderRadius: 10, padding: 10, alignItems: 'center' },
  updateTxt: { color: '#06281c', fontWeight: '900' },
  tribe: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: '#17171f' },
  tribeOn: { backgroundColor: '#8b5cf6' },
  tribeTxt: { color: '#999', fontWeight: '700' },
  tribeTxtOn: { color: '#fff' },
  pwRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingBottom: 8, alignItems: 'center' },
  ghost: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#17171f', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 },
  ghostTxt: { color: '#ddd', fontWeight: '700', fontSize: 12 },
  attach: { paddingHorizontal: 12, paddingBottom: 8 },
  attachHint: { color: '#666', fontSize: 11, marginTop: 6 },
  empty: { color: '#555', textAlign: 'center', marginTop: 60, lineHeight: 24 },
  bubble: { backgroundColor: '#17171f', borderRadius: 12, padding: 10 },
  mine: { backgroundColor: '#241b3d', borderColor: '#8b5cf6', borderWidth: 1 },
  meta: { color: '#888', fontSize: 11, marginBottom: 4, fontWeight: '700' },
  body: { color: '#fff', fontSize: 15, lineHeight: 21 },
  composer: { flexDirection: 'row', gap: 8, padding: 12, alignItems: 'center' },
  tool: { backgroundColor: '#17171f', borderRadius: 12, width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  toolOn: { backgroundColor: '#3a1d1d', borderWidth: 1, borderColor: '#ef4444' },
  toolTxt: { fontSize: 16 },
  send: { backgroundColor: '#8b5cf6', borderRadius: 12, width: 48, height: 44, alignItems: 'center', justifyContent: 'center' },
});
