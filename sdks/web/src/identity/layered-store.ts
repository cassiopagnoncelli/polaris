/**
 * `LayeredIdentityStore` — capability detection + fallback orchestration
 * for the identity-persistence layer.
 *
 * Per `docs/architecture/10-sdk-standards.md`:
 *
 *   - Cookie is preferred when available.
 *   - `anonymous_id` is mirrored into localStorage when available so
 *     identity survives even if the cookie is dropped (Safari ITP cap).
 *   - sessionStorage is used as an additional fallback.
 *   - In-memory identity is the last resort.
 *   - SDK performs capability detection at startup.
 *   - SDK records the storage layer used in diagnostic context.
 *
 * Read order: the layered store reads from the primary layer first; if
 * the primary layer is empty but a lower-priority layer has data, the
 * store copies that record into the primary layer and returns it. This
 * keeps identity sticky across sporadic cookie drops on long-running
 * tabs while keeping the canonical record at the strongest layer.
 *
 * Write order: every write hits the primary layer; the localStorage
 * mirror is also written when localStorage is available *and* is not the
 * primary layer, so the doctrinal "anonymous_id mirrored into
 * localStorage when available" rule from the architecture doc holds.
 */

import type {
  IdentityCapability,
  IdentityStore,
  PersistedIdentity,
  StorageLayer,
} from "../types.js";

export interface LayeredIdentityStoreInputs {
  /**
   * Storage layers in fallback order. The first available layer becomes
   * the primary. Layers later in the list are kept around for the mirror
   * write and for the read-after-fallback behaviour described above.
   */
  readonly stores: readonly IdentityStore[];
  /** Result of capability detection, recorded for diagnostics. */
  readonly capability: IdentityCapability;
  /**
   * Layer to mirror writes into in addition to the primary. Typically
   * `localStorage` per the architecture doc; the manager wires this so
   * the rule is enforced in one place.
   */
  readonly mirrorLayer?: StorageLayer | undefined;
}

export class LayeredIdentityStore {
  private readonly stores: readonly IdentityStore[];
  private readonly capability: IdentityCapability;
  private readonly mirrorLayer: StorageLayer | undefined;
  private currentLayer: StorageLayer;

  public constructor(inputs: LayeredIdentityStoreInputs) {
    if (inputs.stores.length === 0) {
      throw new Error("LayeredIdentityStore: at least one IdentityStore is required");
    }
    this.stores = inputs.stores;
    this.capability = inputs.capability;
    this.mirrorLayer = inputs.mirrorLayer;
    this.currentLayer = inputs.capability.primary;
  }

  public getCapability(): IdentityCapability {
    return this.capability;
  }

  public getCurrentLayer(): StorageLayer {
    return this.currentLayer;
  }

  /**
   * Read the strongest available identity record. If the primary layer is
   * empty but a lower-priority layer has data, the layered store hydrates
   * the primary layer with that data and returns it.
   */
  public read(): PersistedIdentity | null {
    let firstAvailable: IdentityStore | undefined;
    let hydratedFrom: IdentityStore | undefined;
    let hydrated: PersistedIdentity | null = null;

    for (const store of this.stores) {
      if (!store.isAvailable()) continue;
      if (firstAvailable === undefined) firstAvailable = store;
      const value = store.read();
      if (value === null) continue;
      if (firstAvailable === store) {
        this.currentLayer = store.layer;
        return value;
      }
      // Lower-priority layer has data while the primary is empty — keep
      // the record so we can promote it into the primary layer.
      hydratedFrom = store;
      hydrated = value;
      break;
    }

    if (hydrated !== null && hydratedFrom !== undefined && firstAvailable !== undefined) {
      const promoted: PersistedIdentity = {
        ...hydrated,
        storage_layer: firstAvailable.layer,
      };
      const wrote = firstAvailable.write(promoted);
      if (wrote) {
        this.currentLayer = firstAvailable.layer;
        // Best-effort: clear the older copy so the canonical record lives
        // at one layer. Ignore failure — at worst we have a stale mirror
        // that the next write will re-stamp.
        hydratedFrom.clear();
        return promoted;
      }
      // Failed to promote — return the value we found at the lower layer
      // and remember we landed there for diagnostic context.
      this.currentLayer = hydratedFrom.layer;
      return hydrated;
    }

    return null;
  }

  /**
   * Write the identity record to the strongest available layer, then
   * mirror to the localStorage layer when configured. Returns the layer
   * the canonical write actually landed on so the manager can record it.
   */
  public write(identity: PersistedIdentity): StorageLayer {
    let landed: StorageLayer | null = null;
    for (const store of this.stores) {
      if (!store.isAvailable()) continue;
      const stamped: PersistedIdentity = { ...identity, storage_layer: store.layer };
      if (store.write(stamped)) {
        landed = store.layer;
        this.currentLayer = store.layer;
        break;
      }
    }

    if (landed === null) {
      // Final fallback — the memory store is always available and never
      // refuses a write. If even that failed, throw because the SDK
      // cannot proceed without identity.
      throw new Error(
        "LayeredIdentityStore: no storage layer accepted the write (this should never happen)",
      );
    }

    // Mirror into the configured layer (typically localStorage) when it
    // is available, distinct from the canonical layer, and listed in the
    // store chain. The mirror is best-effort: failures are not fatal and
    // the canonical write still succeeded.
    if (this.mirrorLayer !== undefined && this.mirrorLayer !== landed) {
      const mirror = this.findStore(this.mirrorLayer);
      if (mirror?.isAvailable() === true) {
        mirror.write({ ...identity, storage_layer: mirror.layer });
      }
    }

    return landed;
  }

  /** Clear identity across every available layer. */
  public clear(): void {
    for (const store of this.stores) {
      if (store.isAvailable()) store.clear();
    }
  }

  private findStore(layer: StorageLayer): IdentityStore | undefined {
    return this.stores.find((s) => s.layer === layer);
  }
}
