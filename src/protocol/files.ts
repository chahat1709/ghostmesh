// Chunked file transfer over BitChat type 0x22 (FileTransfer).
//
// A file is split into chunks small enough that each one — wrapped in a normal
// signed mesh packet — still fits inside the 512B BLE MTU, so a file travels
// the mesh exactly like any other frame: relayed, TTL-limited, deduped.
// Reassembly is per (senderId, size, total) and expires after FILE_TTL_MS.

import { BLE_MTU } from './bitchat';

export const FILE_KIND = { Text: 0x01, Binary: 0x02 } as const;

/**
 * Chunk payload budget, sized so a chunk wrapped in a signed mesh packet still
 * fits one 512B GATT write:
 *   512 MTU - 14 header - 8 sender - 64 Ed25519 sig - 10 chunk header - 63 name
 * Anything bigger would get re-fragmented at the radio, wasting airtime.
 */
export const FILE_CHUNK = BLE_MTU - 14 - 8 - 64 - 10 - 63; // = 353
export const FILE_TTL_MS = 60_000;
export const MAX_FILE_BYTES = 256 * 1024; // mesh-friendly cap

export interface FileChunkHeader {
  kind: number;
  name: string;
  total: number;
  index: number;
  size: number;
}

function u16be(v: number): Uint8Array {
  return new Uint8Array([(v >> 8) & 0xff, v & 0xff]);
}

function u32be(v: number): Uint8Array {
  return new Uint8Array([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);
}

function readU16(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/** How many chunks this payload needs. */
export function planChunks(byteLength: number, chunkSize = FILE_CHUNK): number {
  if (byteLength <= 0) return 0;
  return Math.ceil(byteLength / chunkSize);
}

/** One chunk payload (goes inside a MsgType.FileTransfer packet). */
export function encodeFileChunk(h: FileChunkHeader, chunk: Uint8Array): Uint8Array {
  const name = new TextEncoder().encode(h.name.slice(0, 63));
  const out = new Uint8Array(1 + 1 + name.length + 2 + 2 + 4 + chunk.length);
  let o = 0;
  out[o++] = h.kind & 0xff;
  out[o++] = name.length;
  out.set(name, o);
  o += name.length;
  out.set(u16be(h.total), o);
  o += 2;
  out.set(u16be(h.index), o);
  o += 2;
  out.set(u32be(h.size), o);
  o += 4;
  out.set(chunk, o);
  return out;
}

export function decodeFileChunk(raw: Uint8Array): (FileChunkHeader & { chunk: Uint8Array }) | null {
  try {
    if (raw.length < 10) return null;
    let o = 0;
    const kind = raw[o++];
    const nlen = raw[o++];
    if (raw.length < 2 + nlen + 8) return null;
    const name = new TextDecoder().decode(raw.slice(o, o + nlen));
    o += nlen;
    const total = readU16(raw, o);
    o += 2;
    const index = readU16(raw, o);
    o += 2;
    const size = readU32(raw, o);
    o += 4;
    if (total === 0 || index >= total) return null;
    return { kind, name, total, index, size, chunk: raw.slice(o) };
  } catch {
    return null;
  }
}

/** Split a file into ready-to-send chunk payloads. */
export function splitFile(
  name: string,
  bytes: Uint8Array,
  kind: number = FILE_KIND.Binary,
  chunkSize = FILE_CHUNK
): Uint8Array[] {
  const total = planChunks(bytes.length, chunkSize);
  const out: Uint8Array[] = [];
  for (let i = 0; i < total; i++) {
    out.push(
      encodeFileChunk(
        { kind, name, total, index: i, size: bytes.length },
        bytes.slice(i * chunkSize, (i + 1) * chunkSize)
      )
    );
  }
  return out;
}

export interface AssembledFile {
  name: string;
  kind: number;
  bytes: Uint8Array;
  from: string;
}

interface Partial {
  parts: (Uint8Array | null)[];
  total: number;
  size: number;
  name: string;
  kind: number;
  ts: number;
}

/**
 * Collects inbound chunks. Keyed by sender so two people sending same-named
 * files can't collide. Emits the whole file once every chunk has arrived.
 */
export class FileAssembler {
  private partials = new Map<string, Partial>();
  onProgress: (name: string, have: number, total: number) => void = () => {};

  add(fromHex: string, raw: Uint8Array, now = Date.now()): AssembledFile | null {
    const c = decodeFileChunk(raw);
    if (!c) return null;
    const key = `${fromHex}|${c.size}|${c.total}|${c.name}`;
    let p = this.partials.get(key);
    if (!p) {
      p = { parts: new Array(c.total).fill(null), total: c.total, size: c.size, name: c.name, kind: c.kind, ts: now };
      this.partials.set(key, p);
    }
    p.parts[c.index] = c.chunk;
    const have = p.parts.filter(Boolean).length;
    this.onProgress(p.name, have, p.total);
    if (have < p.total) return null;
    this.partials.delete(key);
    const total = p.parts.reduce((n, x) => n + (x ? x.length : 0), 0);
    if (total !== p.size) return null; // truncated / lying header
    const bytes = new Uint8Array(total);
    let o = 0;
    for (const part of p.parts) {
      bytes.set(part!, o);
      o += part!.length;
    }
    return { name: p.name, kind: p.kind, bytes, from: fromHex };
  }

  prune(now = Date.now()): void {
    for (const [k, p] of this.partials) {
      if (now - p.ts > FILE_TTL_MS) this.partials.delete(k);
    }
  }

  pending(): number {
    return this.partials.size;
  }
}

/** Render a received text file for the chat feed. */
export function describeFile(f: AssembledFile): string {
  const kb = (f.bytes.length / 1024).toFixed(f.bytes.length < 10240 ? 1 : 0);
  return `📎 ${f.name} · ${kb} KB`;
}
