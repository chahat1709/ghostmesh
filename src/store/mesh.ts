// MeshSession — the controller that binds identity, radio, engine, DMs,
// courier outbox, files, bridge and persistence together.
//
// Deliberately framework-free: no react-native, no zustand. The UI (and
// src/store/meshBinding.ts) subscribes through MeshHandlers, which is also
// what lets scripts/test-mesh.js drive two real sessions against each other
// over LoopbackRadio with no device and no simulator hacks.

import nacl from 'tweetnacl';
import { decodeBase64, decodeUTF8, encodeBase64, encodeUTF8 } from 'tweetnacl-util';
import {
  BitPacket,
  MsgType,
  NO_ADVERTISED_NAME,
  NoisePayload,
  ORIGIN_TTL,
  decodeAnnounce,
  decodeChatMessage,
  encodeAnnounce,
  encodeChatMessage,
  encodePacket,
  hex,
  originTTL,
  unhex,
} from '../protocol/bitchat';
import { hopsFromTTL, MeshEngine, RecvStatus } from '../protocol/meshEngine';
import {
  createIdentity,
  DmSessions,
  Identity,
  openTribeMsg,
  peerIdFromHex,
  randomHex,
  sealTribeMsg,
  signBitPacket,
  tribeKey,
  verifyBitPacket,
} from '../crypto/ghostCrypto';
import { StaticKeypair } from '../crypto/noise';
import { BleTransport, RadioAdapter } from '../protocol/ble';
import { ensureAndroidPermissions } from '../protocol/radio';
import { BridgeClient } from '../protocol/bridge';
import { AssembledFile, FileAssembler, MAX_FILE_BYTES, describeFile, splitFile } from '../protocol/files';
import { ChatMessage, Peer, TRIBES } from '../protocol/types';
import { KEYS, kv, loadJson, saveJson } from './persist';

// Re-exported so the UI can create a first-launch identity without reaching
// into the crypto module directly.
export { createIdentity };

export const AVATAR_COLORS = ['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981', '#ec4899'];

/** Marker byte for a Noise-X courier seal carried in a NoiseEncrypted packet. */
export const COURIER_TAG = 0x00;

export const BURN_TAG = /^\[#burn:(\d+)\]\s/;
export const DEFAULT_BURN_S = 30;
export const ANNOUNCE_EVERY_MS = 30_000;
export const PEER_TIMEOUT_MS = 120_000;
export const OUTBOX_SWEEP_MS = 60_000;

export interface MeshStatus {
  started: boolean;
  radio: { scan: boolean; serve: boolean };
  linkCount: number;
  bridgeOnline: boolean;
  outbox: number;
  peerCount: number;
  /** Why the radio is not on air, when it isn't. Null = healthy. */
  lastError: string | null;
}

export interface MeshHandlers {
  onMessage?(m: ChatMessage): void;
  onDm?(peerHex: string, m: ChatMessage): void;
  onPeer?(p: Peer): void;
  onPeerGone?(peerHex: string): void;
  onFile?(f: AssembledFile): void;
  onStatus?(s: MeshStatus): void;
  onError?(err: unknown): void;
  /** Persist hook — called after any state that must survive a relaunch. */
  onPersist?(): void;
}

export interface MeshOptions {
  identity: Identity;
  /** Radios to run. Defaults to ble-plx central + native peripheral. */
  radios?: RadioAdapter[];
  bridgeUrl?: string;
  handlers?: MeshHandlers;
  announceEveryMs?: number;
  peerTimeoutMs?: number;
  persist?: boolean;
  timer?: {
    set: (fn: () => void, ms: number) => unknown;
    clear: (h: unknown) => void;
  };
  /** 0 = no relay jitter (tests). */
  relayJitterMs?: () => number;
  now?: () => number;
}

export interface SendOpts {
  password?: string;
  burnSeconds?: number;
}

function colorFor(peerHex: string): string {
  let h = 0;
  for (const c of peerHex) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

export { colorFor };

/** Tribe routing inside public broadcast text: `(#ballers) ...` [GM-EXT]. */
export function tagTribe(tribe: string, body: string): string {
  return tribe === 'lobby' ? body : `(#${tribe}) ${body}`;
}

export function untagTribe(content: string): { tribe: string; body: string } {
  const m = /^\((#?)([a-z0-9]+)\)\s/.exec(content);
  if (m && (TRIBES as readonly string[]).includes(m[2])) return { tribe: m[2], body: content.slice(m[0].length) };
  return { tribe: 'lobby', body: content };
}

/** Apply the `[#burn:Ns]` GM-EXT marker. Returns seconds (0 = keep forever). */
export function parseBurn(body: string): { seconds: number; body: string } {
  const m = BURN_TAG.exec(body);
  if (!m) return { seconds: 0, body };
  return { seconds: Number(m[1]) || 0, body: body.slice(m[0].length) };
}

export function withBurn(seconds: number, body: string): string {
  return seconds > 0 ? `[#burn:${Math.floor(seconds)}] ${body}` : body;
}

interface PersistedIdentity {
  peerIdHex: string;
  nick: string;
  color: string;
  signPub: string; // base64
  signPriv: string; // base64 — device-local storage, erased by panic wipe
  staticPub: string; // base64
  staticPriv: string; // base64
}

/** Restore the identity from storage, or null on first launch. */
export function loadIdentity(): Identity | null {
  const p = loadJson<PersistedIdentity>(KEYS.identity);
  if (!p?.peerIdHex || !p.signPriv || !p.staticPriv) return null;
  try {
    const signPriv = decodeBase64(p.signPriv);
    const signPub = decodeBase64(p.signPub);
    const staticKey: StaticKeypair = {
      pub: decodeBase64(p.staticPub),
      priv: decodeBase64(p.staticPriv),
    };
    return {
      peerId: peerIdFromHex(p.peerIdHex),
      peerIdHex: p.peerIdHex,
      staticKey,
      signPub,
      signPriv,
      nick: p.nick,
      color: p.color,
    };
  } catch {
    return null;
  }
}

/** Persist identity. Keys live in device storage so a relaunch keeps the same
 *  ghost — panic wipe is what erases them (KEYS.identity is in allKeys()). */
export function saveIdentity(id: Identity): void {
  const rec: PersistedIdentity = {
    peerIdHex: id.peerIdHex,
    nick: id.nick,
    color: id.color,
    signPub: encodeBase64(id.signPub),
    signPriv: encodeBase64(id.signPriv),
    staticPub: encodeBase64(id.staticKey.pub),
    staticPriv: encodeBase64(id.staticKey.priv),
  };
  saveJson(KEYS.identity, rec);
}

export class MeshSession {
  readonly identity: Identity;
  readonly engine: MeshEngine;
  readonly transport: BleTransport;
  readonly bridge: BridgeClient;
  readonly files = new FileAssembler();
  readonly dm = {
    sessions: null as DmSessions | null,
    ready: (peerHex: string) => this.sessions?.isReady(peerHex) ?? false,
  };

  private handlers: MeshHandlers;
  private sessions: DmSessions | null = null;
  private knownKeys = new Map<string, Uint8Array>();
  private staticKeys = new Map<string, Uint8Array>(); // peerHex -> Curve25519 pub
  private peerState = new Map<string, Peer>();
  private announcedTo = new Set<string>();
  private timers: unknown[] = [];
  private timer: NonNullable<MeshOptions['timer']>;
  private now: () => number;
  private announceEveryMs: number;
  private peerTimeoutMs: number;
  private persistEnabled: boolean;
  private started = false;
  private passwords: Record<string, string> = {};
  private lastError: string | null = null;

  constructor(opts: MeshOptions) {
    this.identity = opts.identity;
    this.handlers = opts.handlers ?? {};
    this.timer =
      opts.timer ??
      {
        set: (fn, ms) => setTimeout(fn, ms),
        clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      };
    this.now = opts.now ?? (() => Date.now());
    this.announceEveryMs = opts.announceEveryMs ?? ANNOUNCE_EVERY_MS;
    this.peerTimeoutMs = opts.peerTimeoutMs ?? PEER_TIMEOUT_MS;
    this.persistEnabled = opts.persist ?? true;

    this.engine = new MeshEngine(this.identity.peerId);
    if (opts.relayJitterMs) this.engine.relayJitterMs = opts.relayJitterMs;
    this.engine.keyForPeer = (h) => this.knownKeys.get(h) ?? null;
    this.engine.onPacket = (p, status) => this.handlePacket(p, status);

    this.transport = new BleTransport({
      radios: opts.radios,
      myPeerId: this.identity.peerId,
      wrap: (payload, type) => this.signPacket({ type, payload, recipientId: undefined }),
      now: this.now,
    });
    this.transport.onFrame = (frame) => this.engine.receive(frame);
    this.transport.onError = (err) => this.noteError(err);
    this.transport.onAdvert = (a) => {
      // RSSI from the radio updates the radar even before a frame arrives
      const existing = this.peerState.get(a.id);
      if (existing) this.upsertPeer({ ...existing, rssi: a.rssi, lastSeen: this.now() });
    };

    this.engine.transport = (frame) => {
      void this.transport.send(frame);
      this.bridge.queue(frame);
    };

    this.bridge = new BridgeClient({
      url: opts.bridgeUrl ?? kv.get(KEYS.bridge) ?? '',
      peerIdHex: this.identity.peerIdHex,
      timer: this.timer,
    });
    this.bridge.onFrame = (frame) => this.engine.receive(frame);
    this.bridge.onError = (err) => this.noteError(err);

    this.sessions = new DmSessions(this.identity.staticKey);
    this.dm.sessions = this.sessions;
    this.knownKeys.set(this.identity.peerIdHex, this.identity.signPub);
    this.staticKeys.set(this.identity.peerIdHex, this.identity.staticKey.pub);
    this.passwords = loadJson<Record<string, string>>(KEYS.passwords) ?? {};
  }

  /** Record a radio/bridge failure so the UI can explain itself. */
  private noteError(err: unknown): void {
    this.lastError = String((err as Error)?.message ?? err);
    this.handlers.onError?.(err);
    this.emitStatus();
  }

  /**
   * Re-ask Android for the Bluetooth permissions and bring the radio back up.
   * Called from the warning bar; without it a denial is a dead end.
   */
  async requestRadioPermissions(): Promise<boolean> {
    const res = await ensureAndroidPermissions();
    if (res.denied.length > 0) {
      this.noteError(new Error('Bluetooth permission denied: ' + res.denied.map((d) => d.split('.').pop()).join(', ')));
      return false;
    }
    await this.transport.stop();
    await this.transport.start();
    this.engine.linkCount = this.transport.linkCount;
    this.lastError = this.transport.blockedBy;
    this.emitStatus();
    return !this.lastError;
  }

  /** Attach (or swap) the render-layer callbacks. */
  setHandlers(h: MeshHandlers): void {
    this.handlers = { ...this.handlers, ...h };
  }

  // --- lifecycle ---

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    if (this.persistEnabled) {
      saveIdentity(this.identity);
      this.engine.importOutbox(loadJson<string[]>(KEYS.outbox) ?? []);
    }
    await this.transport.start();
    this.engine.linkCount = this.transport.linkCount;
    this.bridge.start();
    this.announce();
    this.timers.push(this.timer.set(() => this.loop(), this.announceEveryMs));
    this.emitStatus();
  }

  /** One housekeeping tick: re-announce, sweep the outbox, drop stale peers. */
  private loop(): void {
    this.engine.linkCount = this.transport.linkCount;
    this.announce();
    this.engine.sweepOutbox(this.now());
    this.files.prune(this.now());
    this.prunePeers();
    this.persistOutbox();
    this.emitStatus();
  }

  async stop(): Promise<void> {
    for (const h of this.timers) this.timer.clear(h);
    this.timers = [];
    this.started = false;
    this.bridge.stop();
    await this.transport.stop();
  }

  get isStarted(): boolean {
    return this.started;
  }

  status(): MeshStatus {
    return {
      started: this.started,
      radio: this.transport.roles,
      linkCount: this.transport.linkCount,
      bridgeOnline: this.bridge.stats.online,
      outbox: this.engine.outbox.length,
      peerCount: this.peerState.size,
      lastError: this.lastError ?? this.transport.blockedBy,
    };
  }

  private emitStatus(): void {
    this.handlers.onStatus?.(this.status());
  }

  // --- sending ---

  private signPacket(p: {
    type: number;
    payload: Uint8Array;
    recipientId?: Uint8Array;
    ttl?: number;
    timestampMs?: number;
  }): Uint8Array {
    const unsigned: BitPacket = {
      version: 1,
      type: p.type,
      ttl: p.ttl ?? originTTL(this.engine.linkCount),
      timestampMs: p.timestampMs ?? this.now(),
      senderId: this.identity.peerId,
      recipientId: p.recipientId,
      payload: p.payload,
    };
    return encodePacket({ ...unsigned, signature: signBitPacket(unsigned, this.identity.signPriv) });
  }

  /** Public tribe post. Locked rooms use AES (GM1:); burn uses the GM tag. */
  postTribe(tribe: string, text: string, opts: SendOpts = {}): ChatMessage | null {
    const body = text.trim();
    if (!body) return null;
    const pw = opts.password ?? this.passwords[tribe] ?? '';
    const burned = withBurn(opts.burnSeconds ?? 0, body);
    const content = tagTribe(tribe, pw ? 'GM1:' + sealTribeMsg(tribeKey(tribe, pw), burned) : burned);
    const ts = this.now();
    const id = randomHex(8);
    const payload = encodeChatMessage({ flags: 0, timestampMs: ts, id, sender: this.identity.nick, content });
    this.engine.send(this.signPacket({ type: MsgType.Message, payload, timestampMs: ts }));
    const msg: ChatMessage = {
      id: hex(this.identity.peerId) + ts.toString(16),
      tribe,
      from: this.identity.peerIdHex,
      nick: this.identity.nick,
      color: this.identity.color,
      text: body,
      ts,
      hops: 0,
      mine: true,
      verified: true,
      expiresAt: opts.burnSeconds ? ts + opts.burnSeconds * 1000 : undefined,
    };
    this.handlers.onMessage?.(msg);
    this.persistState();
    return msg;
  }

  /**
   * Direct message. Uses the live Noise XX session when one exists (mutual
   * auth + forward secrecy); otherwise a Noise X courier seal, which also gets
   * queued in the 7-day outbox when the peer is offline.
   */
  sendDm(peerHex: string, text: string, opts: { burnSeconds?: number } = {}): { mode: 'xx' | 'courier' | 'queued' } | null {
    const body = text.trim();
    if (!body || peerHex === this.identity.peerIdHex) return null;
    const ts = this.now();
    const burned = withBurn(opts.burnSeconds ?? 0, body);
    const plaintext = decodeUTF8(burned);
    const online = this.peerState.has(peerHex);

    let frame: Uint8Array;
    let mode: 'xx' | 'courier' | 'queued';
    const session = this.sessions!;
    if (session.isReady(peerHex)) {
      const ct = session.encryptTo(peerHex, NoisePayload.PrivateMessage, plaintext);
      if (!ct) return null;
      frame = this.signPacket({ type: MsgType.NoiseEncrypted, payload: ct, recipientId: peerIdFromHex(peerHex), ttl: ORIGIN_TTL });
      mode = 'xx';
    } else {
      const sealed = this.courierSeal(peerHex, plaintext);
      if (!sealed) return null;
      frame = this.signPacket({ type: MsgType.NoiseEncrypted, payload: sealed, recipientId: peerIdFromHex(peerHex), ttl: ORIGIN_TTL });
      mode = online ? 'courier' : 'queued';
      // Opportunistically negotiate a session for future messages.
      if (online && session) this.beginHandshake(peerHex);
    }

    if (mode === 'queued') this.engine.queueForLater(frame);
    else this.engine.send(frame);
    if (mode === 'queued') this.persistOutbox();

    this.handlers.onDm?.(peerHex, {
      id: randomHex(8),
      tribe: 'dm',
      from: this.identity.peerIdHex,
      nick: this.identity.nick,
      color: this.identity.color,
      text: body,
      ts,
      hops: 0,
      mine: true,
      verified: true,
      expiresAt: opts.burnSeconds ? ts + opts.burnSeconds * 1000 : undefined,
    });
    this.persistState();
    return { mode };
  }

  private courierSeal(peerHex: string, plaintext: Uint8Array): Uint8Array | null {
    const recipPub = this.staticKeys.get(peerHex);
    if (!recipPub) return null;
    const { sealX } = require('../crypto/noise') as typeof import('../crypto/noise');
    const sealed = sealX(this.identity.staticKey, recipPub, plaintext);
    const out = new Uint8Array(1 + sealed.length);
    out[0] = COURIER_TAG;
    out.set(sealed, 1);
    return out;
  }

  /** Send the first XX message to a peer we can currently hear. */
  beginHandshake(peerHex: string): Uint8Array | null {
    if (!this.sessions || this.sessions.isReady(peerHex)) return null;
    const m1 = this.sessions.beginHandshake(peerHex);
    const frame = this.signPacket({ type: MsgType.NoiseHandshake, payload: m1, recipientId: peerIdFromHex(peerHex), ttl: ORIGIN_TTL });
    this.engine.send(frame);
    return m1;
  }

  /** Chunked file: every chunk is its own signed, relayable mesh packet. */
  sendFile(name: string, bytes: Uint8Array, kind = 0x02): number {
    if (bytes.length === 0 || bytes.length > MAX_FILE_BYTES) return 0;
    const chunks = splitFile(name, bytes, kind);
    for (const c of chunks) {
      this.engine.send(this.signPacket({ type: MsgType.FileTransfer, payload: c }));
    }
    return chunks.length;
  }

  /** Plaintext transcript for export (share sheet / file). */
  exportTranscript(tribe: string, msgs: ChatMessage[]): string {
    const head = `GhostMesh #${tribe} — exported ${new Date(this.now()).toISOString()}\n`;
    return (
      head +
      msgs
        .map((m) => `${new Date(m.ts).toISOString()} ${m.nick}${m.mine ? ' (me)' : ''}: ${m.text}`)
        .join('\n')
    );
  }

  // --- receiving ---

  private handlePacket(p: BitPacket, status: RecvStatus): void {
    const fromHex = hex(p.senderId);
    const hops = hopsFromTTL(p.ttl, originTTL(this.engine.linkCount));
    switch (p.type) {
      case MsgType.Announce:
        return this.handleAnnounce(p);
      case MsgType.NoiseHandshake:
        return this.handleHandshake(p);
      case MsgType.NoiseEncrypted:
        return this.handleEncrypted(p, fromHex, hops);
      case MsgType.FileTransfer:
        return this.handleFile(p, fromHex);
      case MsgType.Message: {
        if (status !== 'ok') return;
        const m = decodeChatMessage(p.payload);
        if (!m) return;
        this.deliverPublic(m, fromHex, hops);
        return;
      }
      default:
        return;
    }
  }

  private handleAnnounce(p: BitPacket): void {
    const a = decodeAnnounce(p.payload);
    if (!a) return;
    // self-certifying: the signature must verify against the embedded key
    if (!verifyBitPacket(p, a.signingPub)) return;
    const h = hex(a.peerId);
    this.knownKeys.set(h, a.signingPub);
    this.staticKeys.set(h, a.staticPub);
    const prev = this.peerState.get(h);
    this.upsertPeer({
      pubkey: h,
      nick: a.nick || h.slice(0, 6),
      color: colorFor(h),
      rssi: prev?.rssi ?? -70,
      lastSeen: this.now(),
      hopsAway: Math.max(1, hopsFromTTL(p.ttl, originTTL(this.engine.linkCount))),
      karma: this.engine.karmaFor(h),
    });
    if (!this.announcedTo.has(h)) {
      this.announcedTo.add(h);
      this.announce(); // say hello back, once
    }
    // courier flush: deliver held frames now they're back
    for (const f of this.engine.flushForPeer(a.peerId)) this.engine.transport(f);
    this.persistOutbox();
  }

  private handleHandshake(p: BitPacket): void {
    if (!this.sessions) return;
    // Handshakes are addressed; a relay floods them but must not answer them.
    if (p.recipientId && !p.recipientId.every((b, i) => b === this.identity.peerId[i])) return;
    const fromHex = hex(p.senderId);
    const { reply } = this.sessions.onHandshakeBytes(fromHex, p.payload);
    if (reply) {
      this.engine.send(
        this.signPacket({ type: MsgType.NoiseHandshake, payload: reply, recipientId: p.senderId, ttl: ORIGIN_TTL })
      );
    }
    if (this.sessions.isReady(fromHex)) this.handlers.onStatus?.(this.status());
  }

  private handleEncrypted(p: BitPacket, fromHex: string, hops: number): void {
    if (!p.recipientId) return;
    // Only for us — relays flood the rest without displaying it.
    if (!p.recipientId.every((b, i) => b === this.identity.peerId[i])) return;
    const body = p.payload;
    if (body.length === 0) return;
    const ts = this.now();
    let plaintext: Uint8Array | null = null;

    if (body[0] === COURIER_TAG) {
      const { openX } = require('../crypto/noise') as typeof import('../crypto/noise');
      const opened = openX(this.identity.staticKey, body.slice(1));
      if (opened) {
        plaintext = opened.plaintext;
        this.staticKeys.set(fromHex, opened.senderPub);
      }
    } else {
      const dec = this.sessions?.decryptFrom(fromHex, body);
      if (dec) plaintext = dec.plaintext;
    }
    if (!plaintext) return;
    const parsed = parseBurn(encodeUTF8(plaintext));
    this.handlers.onDm?.(fromHex, {
      id: randomHex(8),
      tribe: 'dm',
      from: fromHex,
      nick: this.peerState.get(fromHex)?.nick ?? fromHex.slice(0, 6),
      color: colorFor(fromHex),
      text: parsed.body,
      ts,
      hops,
      mine: false,
      verified: true,
      expiresAt: parsed.seconds ? ts + parsed.seconds * 1000 : undefined,
    });
    this.persistState();
  }

  private handleFile(p: BitPacket, fromHex: string): void {
    const done = this.files.add(fromHex, p.payload, this.now());
    if (done) {
      this.handlers.onFile?.(done);
      this.handlers.onMessage?.({
        id: randomHex(8),
        tribe: 'lobby',
        from: fromHex,
        nick: this.peerState.get(fromHex)?.nick ?? fromHex.slice(0, 6),
        color: colorFor(fromHex),
        text: describeFile(done),
        ts: this.now(),
        hops: hopsFromTTL(p.ttl, originTTL(this.engine.linkCount)),
        mine: false,
        verified: true,
      });
    }
  }

  private deliverPublic(m: ReturnType<typeof decodeChatMessage>, fromHex: string, hops: number): void {
    if (!m) return;
    const routed = untagTribe(m.content);
    const parsed = parseBurn(routed.body);
    let body = parsed.body;
    if (body.startsWith('GM1:')) {
      const pw = this.passwords[routed.tribe] ?? '';
      const open = openTribeMsg(tribeKey(routed.tribe, pw), body.slice(4));
      if (open === null) {
        body = '🔒 locked room — set the password to read';
      } else {
        const inner = parseBurn(open);
        body = inner.body;
        if (inner.seconds && !parsed.seconds) parsed.seconds = inner.seconds;
      }
    }
    this.handlers.onMessage?.({
      id: m.id,
      tribe: routed.tribe,
      from: fromHex,
      nick: this.peerState.get(fromHex)?.nick ?? m.sender,
      color: colorFor(fromHex),
      text: body,
      ts: m.timestampMs,
      hops,
      mine: false,
      verified: true,
      expiresAt: parsed.seconds ? m.timestampMs + parsed.seconds * 1000 : undefined,
    });
    this.persistState();
  }

  // --- peers ---

  upsertPeer(p: Peer): void {
    this.peerState.set(p.pubkey, p);
    this.handlers.onPeer?.(p);
  }

  prunePeers(now = this.now()): void {
    for (const [h, p] of this.peerState) {
      if (now - p.lastSeen > this.peerTimeoutMs) {
        this.peerState.delete(h);
        this.handlers.onPeerGone?.(h);
      }
    }
  }

  peers(): Peer[] {
    return [...this.peerState.values()].sort((a, b) => b.rssi - a.rssi);
  }

  announce(): void {
    const payload = encodeAnnounce({
      peerId: this.identity.peerId,
      staticPub: this.identity.staticKey.pub,
      signingPub: this.identity.signPub,
      nick: this.identity.nick,
      timestampMs: this.now(),
    });
    this.engine.send(this.signPacket({ type: MsgType.Announce, payload }));
    void NO_ADVERTISED_NAME; // privacy invariant: the radio advertises UUID only
  }

  // --- passwords + persistence ---

  setPassword(tribe: string, pw: string): void {
    this.passwords[tribe] = pw;
    if (this.persistEnabled) saveJson(KEYS.passwords, this.passwords);
  }

  password(tribe: string): string {
    return this.passwords[tribe] ?? '';
  }

  setBridgeUrl(url: string): void {
    kv.set(KEYS.bridge, url);
  }

  private persistState(): void {
    if (!this.persistEnabled) return;
    saveJson(KEYS.peers, this.peers());
    this.handlers.onPersist?.();
  }

  private persistOutbox(): void {
    if (!this.persistEnabled) return;
    saveJson(KEYS.outbox, this.engine.exportOutbox());
  }

  /** Erase every trace: identity, keys, messages, peers, outbox, passwords. */
  wipe(): void {
    this.stop().catch(() => {});
    this.peerState.clear();
    this.knownKeys.clear();
    this.staticKeys.clear();
    this.announcedTo.clear();
    this.engine.outbox = [];
    this.engine.seen.clear();
    this.engine.karma.clear();
    this.passwords = {};
    this.sessions = new DmSessions(this.identity.staticKey);
    kv.clearAll();
  }

  /** Convenience for tests/CLI: build a fresh session with a new identity. */
  static create(opts: Omit<MeshOptions, 'identity'> & { nick?: string; color?: string }): MeshSession {
    const color = opts.color ?? AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
    return new MeshSession({ ...opts, identity: createIdentity(opts.nick ?? `ghost-${randomHex(2)}`, color) });
  }

  /** Re-exported so callers don't need to import hex/unhex themselves. */
  static hexOf(peerId: Uint8Array): string {
    return hex(peerId);
  }

  static bytesOf(peerHex: string): Uint8Array {
    return unhex(peerHex);
  }

  /** base64 of the exported outbox (debug + tests). */
  outboxSnapshot(): string[] {
    return this.engine.exportOutbox().map((s) => encodeBase64(decodeBase64(s)));
  }
}
