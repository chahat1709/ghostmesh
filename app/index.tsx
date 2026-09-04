// GhostMesh main screen — dark cyber UI (deliberately NOT bitchat's terminal green).
// Radio layer is real BitChat tech: binary v1 packets, TTL-7 flood, Ed25519
// announces, Noise XX DMs. Tribes ride as `(#name)` prefixes [GM-EXT].
// Triple-tap the logo = panic wipe (same reflex as bitchat).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TextInput, Pressable, FlatList, StyleSheet, Alert } from 'react-native';
import { Link } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { useChat, AVATAR_COLORS } from '../src/store/chatStore';
import { MeshEngine } from '../src/protocol/meshEngine';
import {
  MsgType,
  decodeAnnounce,
  decodeChatMessage,
  encodeAnnounce,
  encodeChatMessage,
  encodePacket,
  hex,
  originTTL,
} from '../src/protocol/bitchat';
import {
  createIdentity,
  openTribeMsg,
  randomHex,
  sealTribeMsg,
  signBitPacket,
  tribeKey,
  verifyBitPacket,
} from '../src/crypto/ghostCrypto';
import { TRIBES } from '../src/protocol/types';
import * as Application from 'expo-application';
import { checkForApkUpdate, downloadAndInstall } from '../src/updates/selfUpdate';

let engine: MeshEngine | null = null;

function secrets(): { signPriv: Uint8Array; peerId: Uint8Array } {
  return { signPriv: (globalThis as any).__ghostSignPriv, peerId: (globalThis as any).__ghostPeerId };
}

function knownKeys(): Map<string, Uint8Array> {
  if (!(globalThis as any).__knownKeys) (globalThis as any).__knownKeys = new Map();
  return (globalThis as any).__knownKeys;
}

function colorFor(peerHex: string): string {
  let h = 0;
  for (const c of peerHex) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

/** Tribe routing inside public broadcast text: `(#ballers) ...` [GM-EXT]. */
function tagTribe(tribe: string, body: string): string {
  return tribe === 'lobby' ? body : `(#${tribe}) ${body}`;
}

function untagTribe(content: string): { tribe: string; body: string } {
  const m = /^\((#?)([a-z0-9]+)\)\s/.exec(content);
  if (m && (TRIBES as readonly string[]).includes(m[2])) return { tribe: m[2], body: content.slice(m[0].length) };
  return { tribe: 'lobby', body: content };
}

function broadcastAnnounce(me: { peerIdHex: string; nick: string }): void {
  if (!engine) return;
  const { signPriv, peerId } = secrets();
  const st = useChat.getState();
  const myStatic = (globalThis as any).__ghostStaticPub as Uint8Array;
  const mySignPub = knownKeys().get(me.peerIdHex + ':self') as Uint8Array;
  const payload = encodeAnnounce({
    peerId,
    staticPub: myStatic,
    signingPub: mySignPub,
    nick: me.nick,
    timestampMs: Date.now(),
  });
  const unsigned = {
    version: 1 as const,
    type: MsgType.Announce,
    ttl: originTTL(engine.linkCount),
    timestampMs: Date.now(),
    senderId: peerId,
    payload,
  };
  engine.send(encodePacket({ ...unsigned, signature: signBitPacket(unsigned, signPriv) }));
  void st;
}

export default function Home() {
  const { me, setMe, tribe, setTribe, messages, pushMsg, peers, upsertPeer, panicWipe, tribePassword } = useChat();
  const [nick, setNick] = useState('');
  const [text, setText] = useState('');
  const [tapCount, setTapCount] = useState(0);
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

  // onboarding identity — dual BitChat keys (§3)
  if (!me) {
    return (
      <View style={s.center}>
        <Text style={s.logo}>◈ GhostMesh</Text>
        <Text style={s.sub}>off-grid · encrypted · no servers</Text>
        <TextInput style={s.input} placeholder="pick a nickname" placeholderTextColor="#666" value={nick} onChangeText={setNick} maxLength={18} />
        <Pressable
          style={s.btn}
          onPress={() => {
            const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
            const id = createIdentity(nick || `ghost-${randomHex(2)}`, color);
            setMe({ pubkey: id.peerIdHex, nick: id.nick, color });
            (globalThis as any).__ghostSignPriv = id.signPriv; // RAM only
            (globalThis as any).__ghostStaticPub = id.staticKey.pub;
            (globalThis as any).__ghostStatic = id.staticKey;
            (globalThis as any).__ghostPeerId = id.peerId;
            knownKeys().set(id.peerIdHex, id.signPub);
            knownKeys().set(id.peerIdHex + ':self', id.signPub);
            engine = new MeshEngine(id.peerId);
            engine.transport = () => {}; // BleTransport attaches here on native build
            engine.keyForPeer = (h) => knownKeys().get(h) ?? null;
            engine.onPacket = (p, status) => {
              const st = useChat.getState();
              if (p.type === MsgType.Announce) {
                const a = decodeAnnounce(p.payload);
                if (!a) return;
                // self-certifying: signature must verify against the embedded key
                if (!verifyBitPacket(p, a.signingPub)) return;
                const h = hex(a.peerId);
                knownKeys().set(h, a.signingPub);
                st.upsertPeer({
                  pubkey: h,
                  nick: a.nick || h.slice(0, 6),
                  color: colorFor(h),
                  rssi: -70,
                  lastSeen: Date.now(),
                  hopsAway: 1,
                  karma: 0,
                });
                // courier flush: deliver held frames now they're back
                if (engine) for (const f of engine.flushForPeer(a.peerId)) engine.transport(f);
                return;
              }
              if (p.type === MsgType.Message && status === 'ok') {
                const m = decodeChatMessage(p.payload);
                if (!m) return;
                const h = hex(p.senderId);
                const routed = untagTribe(m.content);
                const show = async () => {
                  let body = routed.body;
                  let locked = false;
                  if (body.startsWith('GM1:')) {
                    locked = true;
                    const pw = useChat.getState().tribePassword[routed.tribe] ?? '';
                    const key = await tribeKey(routed.tribe, pw);
                    const open = await openTribeMsg(key, body.slice(4));
                    body = open ?? '🔒 locked room — set the password to read';
                  }
                  const peer = useChat.getState().peers[h];
                  st.pushMsg({
                    id: m.id,
                    tribe: routed.tribe,
                    from: h,
                    nick: peer?.nick ?? m.sender,
                    color: peer?.color ?? colorFor(h),
                    text: body,
                    ts: m.timestampMs,
                    hops: 0,
                    mine: false,
                    verified: true,
                  });
                };
                void show();
              }
            };
            broadcastAnnounce({ peerIdHex: id.peerIdHex, nick: id.nick });
            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }}
        >
          <Text style={s.btnText}>enter the mesh →</Text>
        </Pressable>
        <Text style={s.hint}>Real BitChat radio: binary mesh packets + Noise DMs + tribes + radar. Nothing leaves your phone except signed radio frames.</Text>
      </View>
    );
  }

  const feed = useMemo(() => messages[tribe] ?? [], [messages, tribe]);

  const sendMsg = async () => {
    const body = text.trim();
    if (!body || !engine || !me) return;
    setText('');
    const { signPriv, peerId } = secrets();
    const pw = tribePassword[tribe] ?? '';
    const key = await tribeKey(tribe, pw);
    const content = tagTribe(tribe, pw ? 'GM1:' + (await sealTribeMsg(key, body)) : body);
    const payload = encodeChatMessage({
      flags: 0,
      timestampMs: Date.now(),
      id: randomHex(8),
      sender: me.nick,
      content,
    });
    const unsigned = {
      version: 1 as const,
      type: MsgType.Message,
      ttl: originTTL(engine.linkCount),
      timestampMs: Date.now(),
      senderId: peerId,
      payload,
    };
    engine.send(encodePacket({ ...unsigned, signature: signBitPacket(unsigned, signPriv) }));
    pushMsg({
      id: hex(peerId) + Date.now().toString(16),
      tribe,
      from: me.pubkey,
      nick: me.nick,
      color: me.color,
      text: body,
      ts: Date.now(),
      hops: 0,
      mine: true,
      verified: true,
    });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  };

  const onLogoTap = () => {
    const n = tapCount + 1;
    setTapCount(n);
    if (n >= 3) {
      setTapCount(0);
      Alert.alert('Panic wipe?', 'Deletes identity, messages and peers from this device.', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'WIPE', style: 'destructive', onPress: panicWipe },
      ]);
    }
    setTimeout(() => setTapCount(0), 1200);
  };

  return (
    <View style={s.root}>
      <Pressable onPress={onLogoTap}>
        <View style={s.header}>
          <Text style={s.logoSm}>◈ GhostMesh</Text>
          <Text style={s.peerCount}>{Object.keys(peers).length} nearby</Text>
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
          <Pressable key={t} onPress={() => setTribe(t)} style={[s.tribe, tribe === t && s.tribeOn]}>
            <Text style={[s.tribeTxt, tribe === t && s.tribeTxtOn]}>#{t}</Text>
          </Pressable>
        ))}
      </View>
      <FlatList
        data={feed}
        keyExtractor={(m) => m.id}
        contentContainerStyle={{ padding: 12, gap: 8 }}
        ListEmptyComponent={<Text style={s.empty}>Silent… be the first ghost in #{tribe}.{'\n'}Messages hop phone-to-phone, no internet needed.</Text>}
        renderItem={({ item }) => (
          <View style={[s.bubble, item.mine && s.mine]}>
            <Text style={s.meta}><Text style={{ color: item.color }}>●</Text> {item.nick} · {item.hops === 0 ? 'direct' : `${item.hops} hops`} {item.verified ? '✓' : '⚠'}</Text>
            <Text style={s.body}>{item.text}</Text>
          </View>
        )}
      />
      <View style={s.composer}>
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
  input: { backgroundColor: '#17171f', color: '#fff', borderRadius: 12, padding: 12, width: '100%' },
  btn: { backgroundColor: '#8b5cf6', borderRadius: 12, padding: 14, width: '100%', alignItems: 'center' },
  btnText: { color: '#fff', fontWeight: '800', fontSize: 16 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12 },
  peerCount: { color: '#10b981', fontWeight: '700' },
  radarBtn: { marginLeft: 'auto', backgroundColor: '#17171f', padding: 8, borderRadius: 8 },
  radarTxt: { color: '#06b6d4', fontWeight: '800' },
  tribes: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingBottom: 8 },
  updateBar: { marginHorizontal: 12, marginBottom: 8, backgroundColor: '#10b981', borderRadius: 10, padding: 10, alignItems: 'center' },
  updateTxt: { color: '#06281c', fontWeight: '900' },
  tribe: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999, backgroundColor: '#17171f' },
  tribeOn: { backgroundColor: '#8b5cf6' },
  tribeTxt: { color: '#999', fontWeight: '700' },
  tribeTxtOn: { color: '#fff' },
  empty: { color: '#555', textAlign: 'center', marginTop: 60, lineHeight: 24 },
  bubble: { backgroundColor: '#17171f', borderRadius: 12, padding: 10 },
  mine: { backgroundColor: '#241b3d', borderColor: '#8b5cf6', borderWidth: 1 },
  meta: { color: '#888', fontSize: 11, marginBottom: 4, fontWeight: '700' },
  body: { color: '#fff', fontSize: 15, lineHeight: 21 },
  composer: { flexDirection: 'row', gap: 8, padding: 12 },
  send: { backgroundColor: '#8b5cf6', borderRadius: 12, width: 48, alignItems: 'center', justifyContent: 'center' },
});
