/**
 * Bridge client — the HTTP uplink that lets a mesh reach the internet.
 *
 * The mesh itself never speaks HTTP; a bridge node does. Frames are POSTed to
 * the bridge under our peer id and long-polled back, which keeps the phone
 * free of sockets and lets the relay hold traffic for an offline peer.
 *
 * Protocol (see server/bridge.js):
 *   GET  /health
 *   POST /frames  { peer: <16 hex>, frames: [<base64>...] }
 *   GET  /frames?peer=<16 hex>   -> { frames: [<base64>...] }
 */
import { b64decode, b64encode } from './ble';

export interface BridgeInfo {
  ok: boolean;
  peers: number;
  queued: number;
}

export class BridgeClient {
  online = false;
  lastError: string | null = null;

  constructor(
    private url: string,
    private fetchImpl: typeof fetch = (typeof fetch !== 'undefined' ? fetch : (async () => {
      throw new Error('fetch unavailable');
    }) as any),
    private timeoutMs = 10_000
  ) {}

  get baseUrl(): string {
    return this.url.replace(/\/+$/, '');
  }

  private async req(path: string, init?: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchImpl(this.baseUrl + path, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(t);
    }
  }

  async health(): Promise<BridgeInfo | null> {
    try {
      const r = await this.req('/health');
      if (!r.ok) throw new Error(`health ${r.status}`);
      const j = await r.json();
      this.online = true;
      this.lastError = null;
      return { ok: true, peers: j.peers ?? 0, queued: j.queued ?? 0 };
    } catch (e: any) {
      this.online = false;
      this.lastError = String(e?.message ?? e);
      return null;
    }
  }

  /** Upload frames on behalf of `peerHex`. */
  async post(peerHex: string, frames: Uint8Array[]): Promise<{ accepted: number; rejected: number }> {
    if (!frames.length) return { accepted: 0, rejected: 0 };
    const r = await this.req('/frames', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ peer: peerHex, frames: frames.map(b64encode) }),
    });
    if (!r.ok) throw new Error(`bridge POST ${r.status}`);
    const j = await r.json();
    this.online = true;
    return { accepted: j.accepted ?? 0, rejected: j.rejected ?? 0 };
  }

  /** Pull frames the bridge is holding for `peerHex`. */
  async pull(peerHex: string): Promise<Uint8Array[]> {
    const r = await this.req('/frames?peer=' + encodeURIComponent(peerHex));
    if (!r.ok) throw new Error(`bridge GET ${r.status}`);
    const j = await r.json();
    this.online = true;
    return ((j.frames ?? []) as string[]).map(b64decode);
  }
}
