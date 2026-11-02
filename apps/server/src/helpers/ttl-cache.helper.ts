// Small in-process cache whose entries expire after a fixed TTL. Used for per-tenant lookups
// that run on every request (settings, BYOK credentials, quota state).

// ---------- constants ----------
/** Safety valve: past this many entries the whole cache is dropped rather than scanned. */
const MAX_ENTRIES = 10_000;

// ---------- types ----------
interface Entry<V> {
  value: V;
  expiresAt: number;
}

// ---------- ttl cache ----------
export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: V): void {
    if (this.entries.size > MAX_ENTRIES) this.entries.clear();
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  deletePrefix(prefix: string): void {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }
}
