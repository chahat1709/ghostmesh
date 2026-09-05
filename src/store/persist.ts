// Persistence — MMKV on device, in-memory everywhere else.
//
// `react-native-mmkv` needs the native module, so it is required lazily and
// the whole store falls back to a Map on web / Expo Go / node. That keeps one
// code path: the app always calls kv.get/set, and tests can inject a memory
// store to assert what a relaunch would see.

export interface KvStore {
  readonly backend: 'mmkv' | 'memory';
  get(key: string): string | null;
  set(key: string, value: string): void;
  del(key: string): void;
  /** Remove every GhostMesh key. Panic wipe depends on this actually clearing. */
  clearAll(): void;
  keys(): string[];
}

export const NS = 'gm:';

class MemoryKv implements KvStore {
  readonly backend = 'memory' as const;
  private m = new Map<string, string>();
  // Keys are namespaced exactly like the MMKV backend, so clearAll() (panic
  // wipe) behaves identically on device, web and in tests.
  get(key: string): string | null {
    return this.m.has(NS + key) ? this.m.get(NS + key)! : null;
  }
  set(key: string, value: string): void {
    this.m.set(NS + key, value);
  }
  del(key: string): void {
    this.m.delete(NS + key);
  }
  clearAll(): void {
    for (const k of [...this.m.keys()]) if (k.startsWith(NS)) this.m.delete(k);
  }
  keys(): string[] {
    return [...this.m.keys()].filter((k) => k.startsWith(NS)).map((k) => k.slice(NS.length));
  }
}

class MmkvKv implements KvStore {
  readonly backend = 'mmkv' as const;
  constructor(private store: any) {}
  get(key: string): string | null {
    try {
      return this.store.getString(NS + key) ?? null;
    } catch {
      return null;
    }
  }
  set(key: string, value: string): void {
    try {
      this.store.set(NS + key, value);
    } catch {}
  }
  del(key: string): void {
    try {
      this.store.delete(NS + key);
    } catch {}
  }
  clearAll(): void {
    try {
      // only our namespace, never a blanket wipe of the app container
      const keys: string[] = this.store.getAllKeys() ?? [];
      for (const k of keys) {
        if (String(k).startsWith(NS)) this.store.delete(k);
      }
    } catch {}
  }
  keys(): string[] {
    try {
      const keys: string[] = this.store.getAllKeys() ?? [];
      return keys.filter((k: string) => k.startsWith(NS)).map((k: string) => k.slice(NS.length));
    } catch {
      return [];
    }
  }
}

function makeKv(): KvStore {
  try {
    const { MMKV } = require('react-native-mmkv');
    const store = new MMKV({ id: 'ghostmesh' });
    store.set(NS + 'probe', '1');
    if (store.getString(NS + 'probe') !== '1') return new MemoryKv();
    store.delete(NS + 'probe');
    return new MmkvKv(store);
  } catch {
    return new MemoryKv();
  }
}

/** The process-wide store. Swap with `setKv()` in tests. */
export let kv: KvStore = makeKv();

export function setKv(next: KvStore): void {
  kv = next;
}

export function memoryKv(): KvStore {
  return new MemoryKv();
}

export function saveJson(key: string, value: unknown): void {
  try {
    kv.set(key, JSON.stringify(value));
  } catch {}
}

export function loadJson<T>(key: string): T | null {
  const raw = kv.get(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

// --- storage keys (single source of truth so panic wipe can't miss one) ---

export const KEYS = {
  identity: 'identity',
  identityUi: 'identity:ui',
  messages: 'messages',
  dms: 'dms',
  peers: 'peers',
  passwords: 'passwords',
  outbox: 'outbox',
  tribe: 'tribe',
  bridge: 'bridgeUrl',
} as const;

export type StorageKey = (typeof KEYS)[keyof typeof KEYS];

/** Every key panic wipe must erase. */
export function allKeys(): string[] {
  return Object.values(KEYS);
}
