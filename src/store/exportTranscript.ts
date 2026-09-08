/**
 * Transcript export.
 *
 * `formatTranscript` is pure (covered by the test suite); `exportTranscript`
 * writes it to the app cache directory and opens the share sheet. Both
 * expo-file-system and expo-sharing are already declared dependencies.
 */
import { ChatMessage, Peer } from '../protocol/types';

export interface TranscriptInput {
  me: { pubkey: string; nick: string } | null;
  messages: Record<string, ChatMessage[]>;
  dms: Record<string, ChatMessage[]>;
  peers: Record<string, Peer>;
}

function stamp(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function formatTranscript(input: TranscriptInput, now = Date.now()): string {
  const lines: string[] = [];
  lines.push('GhostMesh transcript');
  lines.push(`exported: ${stamp(now)}`);
  lines.push(`identity: ${input.me ? `${input.me.nick} (${input.me.pubkey})` : 'none'}`);
  lines.push('');

  for (const [tribe, list] of Object.entries(input.messages)) {
    if (!list.length) continue;
    lines.push(`# ${tribe}`);
    for (const m of list) {
      const burn = m.expiresAt ? ' [burns]' : '';
      lines.push(`  ${stamp(m.ts)}  ${m.nick}${m.mine ? ' (you)' : ''}: ${m.text}${burn}`);
    }
    lines.push('');
  }

  for (const [peer, list] of Object.entries(input.dms)) {
    if (!list.length) continue;
    const nick = input.peers[peer]?.nick ?? peer.slice(0, 6);
    lines.push(`# dm ${nick} (${peer})`);
    for (const m of list) {
      lines.push(`  ${stamp(m.ts)}  ${m.mine ? 'you' : nick}: ${m.text}`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd() + '\n';
}

/** Write the transcript and open the share sheet. Throws if sharing fails. */
export async function exportTranscript(input: TranscriptInput): Promise<{ uri: string }> {
  const FileSystem = require('expo-file-system');
  const Sharing = require('expo-sharing');
  const text = formatTranscript(input);
  const uri = `${FileSystem.cacheDirectory}ghostmesh-transcript-${Date.now()}.txt`;
  await FileSystem.writeAsStringAsync(uri, text, { encoding: FileSystem.EncodingType.UTF8 });
  if (await Sharing.isAvailableAsync()) {
    await Sharing.shareAsync(uri, { mimeType: 'text/plain', dialogTitle: 'Export GhostMesh transcript' });
    return { uri };
  }
  // No share sheet on this platform: hand back the file so the caller can
  // show the path.
  return { uri };
}
