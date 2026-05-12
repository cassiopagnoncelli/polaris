/**
 * `localStorage` / `sessionStorage` identity layer.
 *
 * One implementation parameterised by the underlying `Storage` reference
 * keeps the diff small — the only difference between `localStorage` and
 * `sessionStorage` is the lifetime of the data and how the SDK ranks
 * them in the fallback chain. Both layers serialise to the same JSON
 * payload so reads composed across layers stay consistent.
 *
 * `write()` returns `false` if the underlying store rejects the write
 * (quota exceeded, SecurityError on cross-origin iframes, Safari's
 * private-browsing throw). The layered store then falls forward to the
 * next layer rather than swallowing the failure silently.
 */

import { isWebStorageAvailable } from "../internal/environment.js";
import type { IdentityStore, PersistedIdentity, StorageLayer } from "../types.js";
import { deserializeIdentity, serializeIdentity } from "./serialize.js";

const DEFAULT_KEY = "polaris_id";

export interface WebStorageStoreInputs {
  readonly storage: Storage | undefined;
  readonly layer: Extract<StorageLayer, "localStorage" | "sessionStorage">;
  readonly key?: string | undefined;
}

export class WebStorageStore implements IdentityStore {
  public readonly layer: StorageLayer;
  private readonly storage: Storage | undefined;
  private readonly key: string;

  public constructor(inputs: WebStorageStoreInputs) {
    this.storage = inputs.storage;
    this.layer = inputs.layer;
    this.key = inputs.key ?? DEFAULT_KEY;
  }

  public isAvailable(): boolean {
    return isWebStorageAvailable(this.storage);
  }

  public read(): PersistedIdentity | null {
    if (this.storage === undefined) return null;
    try {
      return deserializeIdentity(this.storage.getItem(this.key));
    } catch {
      return null;
    }
  }

  public write(identity: PersistedIdentity): boolean {
    if (this.storage === undefined) return false;
    try {
      this.storage.setItem(this.key, serializeIdentity(identity));
      return this.storage.getItem(this.key) !== null;
    } catch {
      return false;
    }
  }

  public clear(): boolean {
    if (this.storage === undefined) return false;
    try {
      this.storage.removeItem(this.key);
      return this.storage.getItem(this.key) === null;
    } catch {
      return false;
    }
  }
}

/** Factory for the localStorage variant. Kept as a thin alias for readability. */
export class LocalStorageStore extends WebStorageStore {
  public constructor(input: {
    readonly storage: Storage | undefined;
    readonly key?: string | undefined;
  }) {
    super({ storage: input.storage, layer: "localStorage", key: input.key });
  }
}

/** Factory for the sessionStorage variant. */
export class SessionStorageStore extends WebStorageStore {
  public constructor(input: {
    readonly storage: Storage | undefined;
    readonly key?: string | undefined;
  }) {
    super({ storage: input.storage, layer: "sessionStorage", key: input.key });
  }
}
