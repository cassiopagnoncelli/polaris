/**
 * In-memory identity storage. The last-resort layer per the architecture
 * doc: weakest evidence quality, scoped to a single JS execution context,
 * lost on every reload. The SDK only lands here when cookie / localStorage
 * / sessionStorage are all unavailable — typical for some ad WebViews
 * and locked-down iframes.
 */

import type { IdentityStore, PersistedIdentity, StorageLayer } from "../types.js";

export class MemoryStore implements IdentityStore {
  public readonly layer: StorageLayer = "memory";
  private current: PersistedIdentity | null = null;

  public isAvailable(): boolean {
    return true;
  }

  public read(): PersistedIdentity | null {
    return this.current;
  }

  public write(identity: PersistedIdentity): boolean {
    this.current = identity;
    return true;
  }

  public clear(): boolean {
    this.current = null;
    return true;
  }
}
