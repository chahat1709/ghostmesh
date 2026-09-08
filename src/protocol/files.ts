/**
 * File transfer, layered on the existing FileTransfer message type.
 *
 * A 20 KB PDF is ~28 frames of 736 bytes once signed and padded, and BLE drops
 * the odd write, so the receiver has to survive gaps: chunks are indexed, kept
 * out of order, and only assembled once every index has been seen.
 *
 * Frame = [0..16) msgId | [16] flags | [17] nameLen | [18..26) u64 size |
 *         [26..30) u32 chunkIndex | [30..34) u32 chunkCount | [34..42) u64
 *         totalBytes | [42..42+nameLen) name | payload
 */
import { sha256 } from '../crypto/noise';
import { BLE_MTU, MsgType } from './bitchat';
import { hex } from './bitchat';

export const FILE_CHUNK_HEADER = 42;
/** Signed 208-byte overhead (sig) plus the 52-byte header, rounded up to 8. */
export const FILE_CHUNK = (BLE_MTU - FILE_CHUNK_HEADER - 208) & ~7;

const FLAG_LAST = 0x01;

const enc = new TextEncoder();
const dec = new TextDecoder();

export function makeFileChunk(
  msgId: Uint8Array,
  name: string,
  chunkIndex: number,
  chunkCount: number,
  totalBytes: number,
  data: Uint8Array
): Uint8Array {
  if (msgId.length !== 16) throw new Error('msgId must be 16 bytes');
  if (chunkIndex >= 65536) throw new Error('too many chunks in one file');
  const nameBytes = enc.encode(name);
  if (nameBytes.length > 255) throw new Error('file name too long');
  if (data.length > FILE_CHUNK) throw new Error('file chunk too large');
  const flags = chunkIndex === chunkCount - 1 ? FLAG_LAST : 0;

  const out = new Uint8Array(FILE_CHUNK_HEADER + nameBytes.length + data.length);
  out.set(msgId, 0);
  out[16] = flags;
  out[17] = nameBytes.length;
  const dv = new DataView(out.buffer);
  dv.setBigUint64(18, BigInt(totalBytes), false);
  dv.setUint32(26, chunkIndex, false);
  dv.setUint32(30, chunkCount, false);
  dv.setBigUint64(34, BigInt(data.length), false);
  out.set(nameBytes, FILE_CHUNK_HEADER);
  out.set(data, FILE_CHUNK_HEADER + nameBytes.length);
  return out;
}

export function parseFileChunk(raw: Uint8Array): {
  msgId: string;
  name: string;
  chunkIndex: number;
  chunkCount: number;
  data: Uint8Array;
} {
  if (raw.length < FILE_CHUNK_HEADER) throw new Error('file chunk too short');
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const nameLen = raw[17];
  if (raw.length < FILE_CHUNK_HEADER + nameLen) throw new Error('truncated file name');
  const chunkCount = dv.getUint32(30, false);
  const declared = Number(dv.getBigUint64(34, false));
  const data = raw.subarray(FILE_CHUNK_HEADER + nameLen, FILE_CHUNK_HEADER + nameLen + declared);
  if (data.length !== declared) throw new Error('file chunk data truncated');
  if (chunkCount === 0 || dv.getUint32(26, false) >= chunkCount) {
    throw new Error('file chunk index out of range');
  }
  return {
    msgId: hex(raw.subarray(0, 16)),
    name: dec.decode(raw.subarray(FILE_CHUNK_HEADER, FILE_CHUNK_HEADER + nameLen)),
    chunkIndex: dv.getUint32(26, false),
    chunkCount,
    data,
  };
}

export function chunkFile(name: string, bytes: Uint8Array): Uint8Array[] {
  const msgId = sha256(enc.encode(`${name}:${bytes.length}:${Date.now()}`)).subarray(0, 16);
  const count = Math.max(1, Math.ceil(bytes.length / FILE_CHUNK));
  const out: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    out.push(
      makeFileChunk(
        msgId,
        name,
        i,
        count,
        bytes.length,
        bytes.subarray(i * FILE_CHUNK, Math.min(bytes.length, (i + 1) * FILE_CHUNK))
      )
    );
  }
  return out;
}

export interface AssembledFile {
  name: string;
  bytes: Uint8Array;
}

/** Reassembles chunks. Tolerates duplicates, reordering and duplicates of a
 *  missing chunk; emits once the last hole is filled. */
export class FileAssembler {
  private parts = new Map<string, {
    name: string;
    count: number;
    chunks: Map<number, Uint8Array>;
    lastSeen: number;
  }>();

  add(raw: Uint8Array, now = Date.now()): AssembledFile | null {
    let parsed: ReturnType<typeof parseFileChunk>;
    try {
      parsed = parseFileChunk(raw);
    } catch {
      return null;
    }
    let entry = this.parts.get(parsed.msgId);
    if (!entry) {
      entry = { name: parsed.name, count: parsed.chunkCount, chunks: new Map(), lastSeen: now };
      this.parts.set(parsed.msgId, entry);
    }
    entry.lastSeen = now;
    if (!entry.chunks.has(parsed.chunkIndex)) entry.chunks.set(parsed.chunkIndex, parsed.data);
    if (entry.chunks.size < entry.count) return null;

    this.parts.delete(parsed.msgId);
    let total = 0;
    for (const c of entry.chunks.values()) total += c.length;
    const bytes = new Uint8Array(total);
    let off = 0;
    for (let i = 0; i < entry.count; i++) {
      const c = entry.chunks.get(i)!;
      bytes.set(c, off);
      off += c.length;
    }
    return { name: entry.name, bytes };
  }

  /** Progress 0..1 for a partially received file, for the UI. */
  progress(msgId: string): number {
    const e = this.parts.get(msgId);
    return e ? e.chunks.size / e.count : 0;
  }

  dropStale(maxAgeMs = 5 * 60_000, now = Date.now()): void {
    for (const [id, e] of this.parts) if (now - e.lastSeen > maxAgeMs) this.parts.delete(id);
  }

  clear(): void {
    this.parts.clear();
  }
}

export const MSG_FILE_TRANSFER = MsgType.FileTransfer;
