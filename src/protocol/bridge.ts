// Bridge nodes — README's "far peers over uplink when online".
//
// Two phones that cannot hear each other over BLE can still reach each other
// through a bridge: a tiny HTTP relay that only ever stores and forwards
// opaque, already-signed BitChat frames. The bridge cannot read anything
// (tribe traffic is AES-locked, DMs are Noise-encrypted) and cannot forge
// anything (frames carry Ed25519 signatures the mesh verifies on receipt).
//
// Client here; reference relay in server/bridge.js (node, zero deps).
// Everything is optional: with no bridge URL configured the mesh is 100% BLE.

import { b64decode, b64encode } from './b64';
import { decodePacket } from './bitchat';

export interface BridgeOptions {
  url: string;
  /** our 8-byte peer id as hex — the relay routes by this */
  peerIdHex: string;
  pollMs?: number;
  maxBatch?: number;
  fetchImpl?: typeof fetch;
  timer?: { set(fn: () => void, ms: number): unknown; clear(h: unknown): void };
}

export interface BridgeStats {
  published: number;
  pulled: number;
  rejected: number;
  failures: number;
  online: boolean;
}

export class BridgeClient {
  readonly url: string;
  readonly peerIdHex: string;
  private pollMs: number;
  private maxBatch: number;
  private f: typeof fetch;
  private timer: NonNullable<BridgeOptions['timer']>;
  private handle: unknown = null;
  private pending: Uint8Array[] = [];
  stats: BridgeStats = { published: 0, pulled: 0, rejected: 0, failures: 0, online: false };
  /** Frames pulled off the uplink, ready for MeshEngine.receive(). */
  onFrame: (frame: Uint8Array) => void = () => {};
  onError: (err: unknown) => void = () => {};

  constructor(opts: BridgeOptions) {
    this.url = opts.url.replace(/\/$/, '');
    this.peerIdHex = opts.peerIdHex;
    this.pollMs = opts.pollMs ?? 5000;
    this.maxBatch = opts.maxBatch ?? 32;
    this.f = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
    this.timer =
      opts.timer ??
      {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      };
  }

  get enabled(): boolean {
    return this.url.length > 0;
  }

  /** Queue a frame for the uplink (flushed by publishQueued / the poll loop). */
  queue(frame: Uint8Array): void {
    if (!this.enabled) return;
    if (this.pending.length > 200) this.pending.shift();
    this.pending.push(frame);
  }

  /** POST everything queued. Returns how many the relay accepted. */
  async publishQueued(): Promise<number> {
    if (!this.enabled || this.pending.length === 0) return 0;
    const batch = this.pending.splice(0, this.maxBatch);
    try {
      const r = await this.f(`${this.url}/frames`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ peer: this.peerIdHex, frames: batch.map((b) => b64encode(b)) }),
      });
      if (!r.ok) {
        this.stats.failures++;
        this.pending.unshift(...batch); // keep for the next tick
        return 0;
      }
      this.stats.published += batch.length;
      return batch.length;
    } catch (err) {
      this.stats.failures++;
      this.stats.online = false;
      this.pending.unshift(...batch);
      this.onError(err);
      return 0;
    }
  }

  /** Pull frames addressed to us. Non-mesh or corrupt frames are rejected. */
  async poll(): Promise<number> {
    if (!this.enabled) return 0;
    try {
      const r = await this.f(`${this.url}/frames?peer=${encodeURIComponent(this.peerIdHex)}`);
      if (!r.ok) {
        this.stats.failures++;
        this.stats.online = false;
        return 0;
      }
      const j: any = await r.json();
      const frames: string[] = Array.isArray(j?.frames) ? j.frames : [];
      let accepted = 0;
      for (const s of frames) {
        const bytes = b64decode(String(s));
        // Guard: only well-formed v1 packets enter the engine — the relay is
        // not trusted to hand us valid frames.
        if (!decodePacket(bytes)) {
          this.stats.rejected++;
          continue;
        }
        accepted++;
        this.onFrame(bytes);
      }
      this.stats.pulled += accepted;
      this.stats.online = true;
      this.stats.failures = 0;
      return accepted;
    } catch (err) {
      this.stats.failures++;
      this.stats.online = false;
      this.onError(err);
      return 0;
    }
  }

  /** One tick: push what we have, then pull what's waiting. */
  async tick(): Promise<void> {
    await this.publishQueued();
    await this.poll();
  }

  start(): void {
    if (!this.enabled || this.handle !== null) return;
    const loop = () => {
      this.handle = this.timer.set(() => {
        void this.tick().finally(() => {
          if (this.handle !== null) loop();
        });
      }, this.pollMs);
    };
    loop();
  }

  stop(): void {
    if (this.handle !== null) this.timer.clear(this.handle);
    this.handle = null;
  }

  queued(): number {
    return this.pending.length;
  }
}
