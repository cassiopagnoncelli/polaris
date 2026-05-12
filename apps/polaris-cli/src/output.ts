import type { OutputFormat } from "./config.js";

/**
 * Side-effect surface used by command handlers. Tests pass a fake here so
 * assertions can inspect emitted output without parsing real stdout/stderr.
 */
export interface OutputStreams {
  /** Writes a final line terminated with `\n`. Used for command results. */
  readonly writeOut: (text: string) => void;
  /** Writes a diagnostic line to stderr (errors, warnings, hints). */
  readonly writeErr: (text: string) => void;
}

/**
 * Build a streams object backed by `process.stdout` / `process.stderr`.
 *
 * `writeOut` appends a newline if missing so command handlers can pass either
 * plain strings or strings they've already shaped. `writeErr` does the same
 * for stderr.
 */
export function createOutputStreams(): OutputStreams {
  return {
    writeOut: (text) => {
      process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
    },
    writeErr: (text) => {
      process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
    },
  };
}

/**
 * Render a value in the requested output format.
 *
 * For `human`, callers should pass a pre-formatted string. JSON-rendered
 * structured values are produced via `renderJson` so the human and JSON paths
 * stay independent and tests can verify each.
 */
export function renderHuman(value: string): string {
  return value;
}

/**
 * Render a structured value as pretty-printed JSON with a trailing newline.
 *
 * Pretty-printing is on by default because operator-facing CLIs are read by
 * humans first, machines second; downstream pipelines that need compact JSON
 * pipe through `jq -c` or similar. Two-space indent matches the rest of the
 * repo's JSON output conventions.
 */
export function renderJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * Pick the renderer matching the requested format. Used by commands that have
 * a one-line human form and a structured JSON form for the same payload.
 */
export function renderAccordingTo(
  format: OutputFormat,
  payload: { readonly human: string; readonly json: unknown },
): string {
  return format === "json" ? renderJson(payload.json) : renderHuman(payload.human);
}
