/**
 * Redaction-safe wrapper for secret values.
 *
 * Project-config snapshots carry credentials themselves rather than references
 * to them, which means plaintext lives in the cache for the snapshot's
 * lifetime. This box removes the whole class of accidental disclosure that
 * would otherwise follow: every path that turns an object into text —
 * `console.log`, a pino serializer, `JSON.stringify` into a DLQ payload or
 * delivery record, string interpolation into an error message, `util.inspect`
 * in a stack trace — yields `[redacted]`.
 *
 * This is what survived the move from `provider:ref` pointers to stored
 * values. The box never had anything to do with WHERE a secret came from; it
 * is about what happens to plaintext once something holds it, and holding
 * plaintext is now the normal case rather than the brief one.
 *
 * Disclosure therefore requires an explicit {@link Secret.expose} call, which
 * is greppable and lint-restrictable to the modules that actually talk to a
 * vendor.
 *
 * What this does NOT protect against, and cannot: the value is a JS string in
 * the heap, so a heap dump or core dump contains it for as long as the
 * snapshot is cached. JS strings are immutable and GC timing is not
 * controllable, so there is no zeroing story. That is a documented property of
 * caching resolved values.
 *
 * @see docs/implementation/project-config-plan.md §6
 */
export class Secret<T = string> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  /**
   * Unwrap the value. The only way to reach plaintext — keep call sites at
   * the point of use (a deliverer handing a token to a vendor client), never
   * in logging, mapping, or record-building code.
   */
  expose(): T {
    return this.#value;
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "Secret([redacted])";
  }
}

/** Whether a value is a {@link Secret} box. */
export function isSecret(value: unknown): value is Secret<unknown> {
  return value instanceof Secret;
}
