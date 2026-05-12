/**
 * SDK version stamped into `source.sdk_version`.
 *
 * The Web SDK runs in browsers and bundlers — it cannot read `package.json`
 * at runtime the way the Node SDK does. Keeping the version as a constant
 * here means we have to bump it alongside `package.json` (one source of
 * truth: the package.json `version` field is the canonical npm version).
 * The bundler / publish step is responsible for keeping these in sync —
 * we surface a CI check in P11 if this turns out to drift.
 *
 * Default `0.0.0` reflects the workspace-private nature of the package
 * pre-release; the value will move in lockstep with the package.json
 * `version` when the SDK ships externally.
 */

export const SDK_VERSION = "0.0.0";
