/**
 * Failures raised by the project-config read store.
 *
 * None of these carry a resolved secret value: they describe the lookup, not
 * the result. Assembly failures preserve their cause so a Vault transport
 * error can surface in observability without retyping.
 */

/** Base class for project-config read failures. */
export abstract class ProjectConfigError extends Error {
  protected constructor(name: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = name;
  }
}

/**
 * A key was requested from a {@link import("./types.js").PinnedConfig} that
 * was not part of the `pin()` call.
 *
 * This is a programming error, not a data condition: batch code must collect
 * every scope it will touch before pinning, so a miss means the collection
 * pass and the processing pass disagree.
 */
export class PinMissingError extends ProjectConfigError {
  public readonly projectId: string;
  public readonly environment: string;
  public readonly namespace: string;

  constructor(projectId: string, environment: string, namespace: string) {
    super(
      "PinMissingError",
      `project config for (${projectId}, ${environment}, ${namespace}) was not pinned for this batch`,
    );
    this.projectId = projectId;
    this.environment = environment;
    this.namespace = namespace;
  }
}

/**
 * A snapshot could not be assembled.
 *
 * Thrown for database failures and for secret-resolution failures alike; the
 * `cause` distinguishes them. Callers classify transient from permanent —
 * this layer deliberately does not, because "retry" versus "DLQ" is a delivery
 * decision, not a storage one.
 */
export class ProjectConfigAssemblyError extends ProjectConfigError {
  public readonly projectId: string;
  public readonly environment: string;
  public readonly namespace: string;

  constructor(
    projectId: string,
    environment: string,
    namespace: string,
    options?: { cause?: unknown },
  ) {
    super(
      "ProjectConfigAssemblyError",
      `failed to assemble project config for (${projectId}, ${environment}, ${namespace})`,
      options,
    );
    this.projectId = projectId;
    this.environment = environment;
    this.namespace = namespace;
  }
}
