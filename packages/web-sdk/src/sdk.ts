/**
 * `PolarisWebSdk` — public surface stub for `@polaris/web-sdk`.
 *
 * This task (P3-002) ships the identity-persistence layer only. The
 * queue (IndexedDB + localStorage + memory), HTTPS transport, batch
 * flush, retry, and `track()` semantics land in P3-003 (Web SDK Queue
 * and Transport).
 *
 * The class is exposed here so the public surface shape — `track`,
 * `identify`, `reset`, `flush` per `docs/architecture/10-sdk-standards.md` —
 * is stable for documentation, type-checking by consumers writing
 * scaffolding, and to give P3-003 a single class to add transport
 * wiring into. The methods that aren't part of this task throw a
 * descriptive error rather than silently no-oping so a producer that
 * accidentally wires the SDK against P3-002 sees a clear failure.
 *
 * Identity surface is fully wired and tested in P3-002:
 *
 *   - `identify(customerId, traits?)`
 *   - `reset(options?)`
 *   - identity state accessors (anonymous/session/customer IDs)
 *   - diagnostics (capability, storage layer, WebView flag)
 */

import { IdentityManager } from "./identity/manager.js";
import type {
  EnvelopeIdentity,
  IdentifyTraits,
  IdentityCapability,
  IdentityDiagnostics,
  ResetOptions,
  WebSdkOptions,
} from "./types.js";

export class PolarisWebSdk {
  private readonly identityManager: IdentityManager;

  public constructor(options: WebSdkOptions = {}) {
    this.identityManager = new IdentityManager(options.identity);
  }

  // --- identity surface (P3-002) ---------------------------------------

  /** Identity manager for callers that want direct access to the layered store. */
  public getIdentityManager(): IdentityManager {
    return this.identityManager;
  }

  /** Capability detection snapshot. */
  public getCapability(): IdentityCapability {
    return this.identityManager.getCapability();
  }

  /** Diagnostic snapshot (storage layer, capability, last activity timestamp). */
  public getDiagnostics(): IdentityDiagnostics {
    return this.identityManager.getDiagnostics();
  }

  /** Envelope-shaped identity for the queue/transport layer in P3-003. */
  public getEnvelopeIdentity(): EnvelopeIdentity {
    return this.identityManager.toEnvelopeIdentity();
  }

  /** Associate a `customer_id` with subsequent events. */
  public identify(customerId: string, traits?: IdentifyTraits): void {
    this.identityManager.identify(customerId, traits);
  }

  /**
   * Per `10-sdk-standards.md`:
   *
   *   reset()                       -> clears customer_id, rotates session_id,
   *                                    rotates anonymous_id
   *   reset({ anonymous: false })   -> clears customer_id, rotates session_id,
   *                                    keeps anonymous_id
   */
  public reset(options?: ResetOptions): void {
    this.identityManager.reset(options);
  }

  // --- placeholders for P3-003 -----------------------------------------

  /**
   * Public-surface stub for `track`. Will be implemented in P3-003 with
   * the queue + transport layer. Throws to surface mis-wiring during the
   * P3-002 review window.
   */
  public track(_event: string, _properties?: Record<string, unknown>): Promise<string> {
    return Promise.reject(
      new Error(
        "PolarisWebSdk.track() is not implemented in this build (P3-002 ships identity only; track lands in P3-003)",
      ),
    );
  }

  /** Public-surface stub for `flush`. Implemented in P3-003. */
  public flush(): Promise<void> {
    return Promise.reject(
      new Error(
        "PolarisWebSdk.flush() is not implemented in this build (P3-002 ships identity only; flush lands in P3-003)",
      ),
    );
  }
}
