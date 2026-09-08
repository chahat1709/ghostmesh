// Proximity radar — bitchat has a peer list; GhostMesh shows a live signal map
// with distance rings (RSSI), hop count and karma (relay reputation).
import React from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Link } from 'expo-router';
import { useChat } from '../src/store/chatStore';
import { getSession } from '../src/store/sessionHost';

function ring(rssi: number): { r: number; label: string } {
  if (rssi > -60) return { r: 46, label: 'close' };
  if (rssi > -75) return { r: 92, label: 'near' };
  return { r: 138, label: 'far' };
}

export default function Radar() {
  const { peers } = useChat();
  const list = Object.values(peers);
  return (
    <View style={s.root}>
      <View style={s.scope}>
        <View style={[s.ring, { width: 276, height: 276 }]} />
        <View style={[s.ring, { width: 184, height: 184 }]} />
        <View style={[s.ring, { width: 92, height: 92 }]} />
        <View style={s.me}><Text style={{ color: '#fff', fontWeight: '900' }}>◈</Text></View>
        {list.slice(0, 12).map((p, i) => {
          const { r } = ring(p.rssi);
          const a = (i / Math.max(1, list.length)) * Math.PI * 2;
          return (
            <View key={p.pubkey} style={[s.dot, { left: 150 + Math.cos(a) * r - 14, top: 150 + Math.sin(a) * r - 14, backgroundColor: p.color }]}>
              <Text style={s.dotTxt}>{p.nick.slice(0, 2).toUpperCase()}</Text>
            </View>
          );
        })}
      </View>
      {list.map((p) => {
        const session = getSession();
        const ready = session?.peerList().find((x) => x.peerHex === p.pubkey)?.ready ?? false;
        return (
          <Link key={p.pubkey} href={{ pathname: '/dm', params: { peer: p.pubkey } }} asChild>
            <Pressable style={s.rowBtn}>
              <Text style={s.row}>
                <Text style={{ color: p.color }}>●</Text> {p.nick} · {p.rssi}dBm ·{' '}
                {p.hopsAway <= 1 ? 'direct' : `${p.hopsAway} hops`} · karma {p.karma}
                {ready ? ' · 🔒 session open' : ''}
              </Text>
              <Text style={s.dm}>DM →</Text>
            </Pressable>
          </Link>
        );
      })}
      {list.length === 0 && <Text style={s.empty}>No ghosts yet. Walk around — phones find each other over BLE automatically.</Text>}
    </View>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#0b0b12', padding: 16, gap: 8 },
  scope: { width: 300, height: 300, alignSelf: 'center', marginVertical: 12 },
  ring: { position: 'absolute', left: 150, top: 150, borderColor: '#26263a', borderWidth: 1, borderRadius: 999, transform: [{ translateX: -138 }, { translateY: -138 }] },
  me: { position: 'absolute', left: 150, top: 150, width: 28, height: 28, marginLeft: -14, marginTop: -14, borderRadius: 14, backgroundColor: '#8b5cf6', alignItems: 'center', justifyContent: 'center' },
  dot: { position: 'absolute', width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  dotTxt: { color: '#fff', fontSize: 10, fontWeight: '900' },
  row: { color: '#ccc', paddingVertical: 4 },
  rowBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  dm: { color: '#8b5cf6', fontWeight: '900' },
  empty: { color: '#555', textAlign: 'center', marginTop: 20 },
});
