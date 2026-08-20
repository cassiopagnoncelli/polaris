/**
 * Bounded least-recently-used map.
 *
 * Deliberately dependency-free and minimal: JS `Map` preserves insertion
 * order, so delete-then-set moves a key to the most-recent end and the oldest
 * key is always the first one iteration yields.
 */
export class BoundedLru<K, V> {
  readonly #entries = new Map<K, V>();
  readonly #capacity: number;
  readonly #onEvict: ((key: K, value: V) => void) | undefined;

  constructor(capacity: number, onEvict?: (key: K, value: V) => void) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, received ${String(capacity)}`);
    }
    this.#capacity = capacity;
    this.#onEvict = onEvict;
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Read and mark most-recently-used. */
  get(key: K): V | undefined {
    const value = this.#entries.get(key);
    if (value === undefined) return undefined;
    this.#entries.delete(key);
    this.#entries.set(key, value);
    return value;
  }

  /** Read WITHOUT affecting recency — for sweeps that must not reorder. */
  peek(key: K): V | undefined {
    return this.#entries.get(key);
  }

  has(key: K): boolean {
    return this.#entries.has(key);
  }

  set(key: K, value: V): void {
    if (this.#entries.has(key)) this.#entries.delete(key);
    this.#entries.set(key, value);
    while (this.#entries.size > this.#capacity) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) break;
      const evicted = this.#entries.get(oldest.value) as V;
      this.#entries.delete(oldest.value);
      this.#onEvict?.(oldest.value, evicted);
    }
  }

  delete(key: K): boolean {
    return this.#entries.delete(key);
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Snapshot of entries, oldest first. Safe to mutate the map while iterating. */
  entries(): readonly (readonly [K, V])[] {
    return [...this.#entries.entries()];
  }

  keys(): readonly K[] {
    return [...this.#entries.keys()];
  }
}
