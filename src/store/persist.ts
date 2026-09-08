/**
 * Key-value store abstraction.
 *
 * On device this is `react-native-mmkv` (a declared dependency that was
 * listed in package.json but never imported anywhere). Everywhere else it
 * falls back to a synchronous in-memory map so the core logic stays testable.
 *
 * Every key is namespaced so `clearAll` (the panic button) can wipe our data
 * without touching anything the host app owns.
 */
export interface KvStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
  /** Delete every key this app owns. */
  clearAll(): void;
}

export class MemoryKv implements KvStore {
  private map = new Map<string, string>();

  get(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  set(key: string, value: string): void {
    this.map.set(key, value);
  }
  remove(key: string): void {
    this.map.delete(key);
  }
  clearAll(): void {
    for (const k of [...this.map.keys()]) {
      if (k.startsWith(NS)) this.map.delete(k);
    }
  }
  keys(): string[] {
    return [...this.map.keys()];
  }
}

const NS = 'gm:';

class MmkvKv implements KvStore {
  constructor(private readonly inner: {
    getString(k: string): string | undefined;
    set(k: string, v: string): void;
    delete(k: string): void;
    clearAll(): void;
    getAllKeys(): string[];
  }) {}

  get(key: string): string | null {
    const v = this.inner.getString(NS + key);
    return v === undefined ? null : v;
  }
  set(key: string, value: string): void {
    this.inner.set(NS + key, value);
  }
  remove(key: string): void {
    this.inner.delete(NS + key);
  }
  clearAll(): void {
    // Scoped rather than inner.clearAll(): never destroy a host app's keys.
    for (const k of this.inner.getAllKeys()) {
      if (k.startsWith(NS)) this.inner.delete(k);
    }
  }
}

let cache: KvStore | null = null;

export function getKv(): KvStore {
  if (cache) return cache;
  let kv: KvStore = new MemoryKv();
  try {
    // Required lazily: importing MMKV outside React Native throws.
    const { MMKV } = require('react-native-mmkv');
    const instance = new MMKV({ id: 'ghostmesh' });
    kv = new MmkvKv(instance);
  } catch {
    /* Expo Go / web / node: stay in memory. */
  }
  cache = kv;
  return kv;
}

/** Test hook. */
export function setKv(kv: KvStore | null): void {
  cache = kv;
}
