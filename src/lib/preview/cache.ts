/**
 * Tiny LRU with per-entry expiry (Phase 6 preview cache). Pure module. Keyed by URL; a `null` value is a
 * remembered miss (no preview / failed), kept for a shorter time than a hit.
 */
export interface LruOptions {
  /** Max entries; the least recently read is evicted first. */
  max: number;
  /** Lifetime of a non-null value, ms. */
  ttlMs: number;
  /** Lifetime of a `null` value (negative cache), ms. */
  negativeTtlMs: number;
  now?: () => number;
}

interface Entry<V> {
  value: V | null;
  expires: number;
}

export class LruCache<V> {
  private readonly map = new Map<string, Entry<V>>();
  private readonly opts: Required<LruOptions>;

  constructor(opts: LruOptions) {
    this.opts = { now: Date.now, ...opts };
  }

  /** `undefined` = unknown; `null` = known miss; else the value. Reading refreshes recency. */
  get(key: string): V | null | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires <= this.opts.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  set(key: string, value: V | null): void {
    const ttl = value === null ? this.opts.negativeTtlMs : this.opts.ttlMs;
    this.map.delete(key);
    this.map.set(key, { value, expires: this.opts.now() + ttl });
    while (this.map.size > this.opts.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
