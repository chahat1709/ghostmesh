// Proximity radar — bitchat has a peer list; GhostMesh shows a live signal map
// with distance rings (RSSI from the radio), hop count derived from TTL decay
// and karma (how much traffic that ghost has actually delivered us).
import React from 'react';
import { View, Text, StyleSheet, ScrollView, Pressable } from 'react-native';
import { router } from 'expo-router';
import { useChat } from '../src/store/chatStore';
import { getSession } from '../src/store/sessionHost';

function ring(rssi: number): { r: number; label: string } {
  if (rssi > -60) return { r: 46, label: 'close' };
  if (rssi > -75) return { r: 92, label: 'near' };
  return { r: 138, label: 'far' };
}

export default function Radar() {
  const { peers, status } = useChat();
  const list = Object.values(peers).sort((a, b) => b.rssi - a.rssi);
  const karma = (hex: string) => getSession()?.engine.karmaFor(hex) ?? peers[hex]?.karma ?? 0;
  const roles = status.radio;
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
      <View style={s.statRow}>
        <Text style={s.stat}>radio: {roles.scan ? (roles.serve ? 'central + peripheral' : 'central only') : 'off'}</Text>
        <Text style={s.stat}>links: {status.linkCount}</Text>
        <Text style={s.stat}>outbox: {status.outbox}</Text>
        <Text style={[s.stat, { color: status.bridgeOnline ? '#10b981' : '#666' }]}>bridge: {status.bridgeOnline ? 'online' : 'off'}</Text>
      </View>
      <ScrollView>
        {list.map((p) => (
          <Pressable key={p.pubkey} style={s.row} onPress={() => router.push(`/dm?peer=${p.pubkey}`)}>
            <Text style={s.rowTxt}>
              <Text style={{ color: p.color }}>●</Text> {p.nick} · {p.rssi}dBm ({ring(p.rssi).label}) ·{' '}
              {p.hopsAway <= 1 ? 'direct' : `${p.hopsAway} hops`} · karma {karma(p.pubkey)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
      {list.length === 0 && (
        <Text style={s.empty}>No ghosts yet. Walk around — phones find each other over BLE automatically.</Text>
      )}
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
  statRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, paddingVertical: 4 },
  stat: { color: '#06b6d4', fontSize: 11, fontWeight: '800' },
  row: { paddingVertical: 6 },
  rowTxt: { color: '#ccc' },
  empty: { color: '#555', textAlign: 'center', marginTop: 20 },
});
