/** A small in-memory cache for answers: least recently used out first, entries expire. */
export class TtlCache<V> {
  private readonly map = new Map<string, { value: V; expires: number }>();

  constructor(private readonly max = 200) {}

  get(key: string, now: number): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    this.map.delete(key);
    if (hit.expires <= now) return undefined;
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V, ttlMs: number, now: number): void {
    this.map.delete(key);
    this.map.set(key, { value, expires: now + ttlMs });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
}
