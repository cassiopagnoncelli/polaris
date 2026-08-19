// Terminal output for the local entry points. `bin/setup` is the only caller
// today; `bin/dev` prints in the same shape by hand and is the reason nothing
// here knows what an install is.
//
// Node builtins only, and that is a constraint rather than a preference:
// `bin/setup` runs `pnpm install` as one of its own steps, so every module it
// imports has to load on a checkout whose `node_modules` is empty, stale, or
// half-written. Picocolors would be the obvious dependency and cannot be one.
// What follows is the subset of it this repo actually uses.
//
// Everything here degrades instead of breaking, because the same output has to
// survive being redirected. With colour unsupported the style functions are
// the identity; off a TTY the live line stops animating and prints once, when
// it has something final to say; without UTF-8 the symbols fall back to ASCII.
// `make setup > install.log` therefore records what the terminal showed, minus
// the animation and the escape codes — which is what makes it worth attaching
// to a bug report.

/**
 * Whether to emit colour, decided once at import.
 *
 * The precedence is everyone else's, so that a developer's existing settings
 * mean here what they mean everywhere: `NO_COLOR` beats `FORCE_COLOR` beats
 * autodetection (https://no-color.org). `TERM=dumb` is excluded because an
 * Emacs shell buffer sets it and renders escapes literally. `CI` is included
 * because every CI log viewer worth using renders them.
 */
export const supportsColor = (() => {
  const env = process.env;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "0") return true;
  if (env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY) || env.CI !== undefined;
})();

/**
 * Whether the cursor can be moved around — the thing a spinner needs and a
 * log file cannot give. Separate from {@link supportsColor} on purpose: CI
 * wants the colour and must not get the animation, or its log fills with
 * thousands of half-erased frames.
 */
export const isInteractive = Boolean(process.stdout.isTTY) && process.env.TERM !== "dumb";

/**
 * The column budget for one line, clamped at both ends.
 *
 * The floor keeps a narrow split pane from collapsing the right-hand column
 * onto the left; the ceiling keeps a maximised terminal from flinging the step
 * timings a screen away from the step names. One short of the real width,
 * because a line that fills the last column wraps on some terminals and leaves
 * a blank one behind every step.
 */
export function width() {
  return Math.max(40, Math.min((process.stdout.columns ?? 80) - 1, 88));
}

const style = (open, close) => (text) =>
  supportsColor ? `\x1b[${open}m${text}\x1b[${close}m` : String(text);

export const bold = style(1, 22);
export const dim = style(2, 22);
export const red = style(31, 39);
export const green = style(32, 39);
export const cyan = style(36, 39);

/**
 * Glyphs, with an ASCII fallback for terminals that would render the good
 * ones as mojibake.
 *
 * Detection is by locale rather than by feature test because there is no
 * feature test: the terminal never says what it can draw. Every modern macOS
 * and Linux terminal sets a UTF-8 locale, and the ones that do not are
 * precisely the ones that need the fallback.
 */
const unicode =
  process.platform === "darwin" ||
  /UTF-?8$/i.test(process.env.LC_ALL ?? process.env.LC_CTYPE ?? process.env.LANG ?? "");

export const symbols = unicode
  ? { ok: "✔", fail: "✘", pending: "·", bullet: "◆", arrow: "›", pipe: "│" }
  : { ok: "+", fail: "x", pending: ".", bullet: "*", arrow: ">", pipe: "|" };

const SPINNER_FRAMES = unicode
  ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  : ["-", "\\", "|", "/"];
const SPINNER_INTERVAL_MS = 80;

const CLEAR_LINE = "\r\x1b[2K";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

let cursorHidden = false;
let restoreRegistered = false;

/**
 * Put the cursor back whatever happens next.
 *
 * A hidden cursor outlives the process that hid it, so a run that dies part
 * way through leaves the developer's shell with no cursor until they type
 * `reset`. `exit` covers the ordinary and the thrown cases; the signals need
 * their own handlers because Node runs no `exit` listeners for a default
 * signal death, and Ctrl-C during a five-minute `pnpm install` is the single
 * most likely way this script ever ends.
 */
function registerCursorRestore() {
  if (restoreRegistered) return;
  restoreRegistered = true;
  process.on("exit", showCursor);
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ]) {
    process.on(signal, () => {
      showCursor();
      process.exit(code);
    });
  }
}

function hideCursor() {
  if (!isInteractive || cursorHidden) return;
  cursorHidden = true;
  registerCursorRestore();
  process.stdout.write(HIDE_CURSOR);
}

function showCursor() {
  if (!cursorHidden) return;
  cursorHidden = false;
  process.stdout.write(SHOW_CURSOR);
}

/**
 * A line that animates while something is happening and is then replaced by
 * what happened.
 *
 * The caller styles both texts; this only owns the spinner, the erasing, and
 * the fallback. Off a TTY the pending text is dropped entirely rather than
 * printed and superseded — a log that says "installing dependencies" and then
 * "installed dependencies" is twice the length for none of the information.
 *
 * One at a time. The scripts that use this run their steps in sequence, and
 * tracking several would mean tracking how far up the screen each one is.
 */
export function liveLine(pending) {
  if (!isInteractive) {
    return {
      update() {},
      end(final) {
        if (final !== undefined) console.log(final);
      },
    };
  }

  let text = pending;
  let frame = 0;
  const render = () => {
    process.stdout.write(`${CLEAR_LINE}${cyan(SPINNER_FRAMES[frame])} ${text}`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  };

  hideCursor();
  render();
  // `unref` so a forgotten `end()` cannot hold the process open past its work.
  const timer = setInterval(render, SPINNER_INTERVAL_MS).unref();

  return {
    update(next) {
      text = next;
    },
    end(final) {
      clearInterval(timer);
      process.stdout.write(CLEAR_LINE);
      showCursor();
      if (final !== undefined) console.log(final);
    },
  };
}

/** `1.4s`, `12s`, `3m 07s` — two significant figures is all anyone reads. */
export function duration(ms) {
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, "0")}s`;
}

/**
 * Pad `text` to `size` visible characters.
 *
 * Styling has to be applied after padding, never before — `padEnd` counts the
 * escape sequences, so a coloured string pads to the wrong width and the
 * column it was lining up with drifts by exactly the length of the escapes.
 */
export function pad(text, size) {
  return String(text).padEnd(size);
}

/**
 * `left`, then `right` flushed against `column`.
 *
 * Both sides are measured with the escapes removed, so a caller can style
 * either one and still get the column it asked for — styling before measuring
 * is the bug this exists to make impossible.
 *
 * `column` defaults to the full line, but a caller lining up a list is usually
 * better off naming a narrower one: flushed to the width of a maximised
 * terminal, a short label and its number end up a hand's width apart.
 */
export function rightAlign(left, right, column = width()) {
  const gap = column - stripAnsi(left).length - stripAnsi(right).length;
  return `${left}${" ".repeat(Math.max(gap, 1))}${right}`;
}

/** Visible length, for aligning something that has already been styled. */
export function stripAnsi(text) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the escapes is the point.
  return String(text).replace(/\x1b\[[0-9;]*m/g, "");
}

/** A blank line, a heading, and nothing else — the phases of a long script. */
export function section(title) {
  console.log(`\n  ${bold(title)}`);
}

/**
 * A block of someone else's output, marked as quoted.
 *
 * The rule is dim, the text is not. This is only ever reached for output worth
 * reading — the tail of the step that just failed — and dimming the one thing
 * on the screen the reader came for would be a strange way to present it.
 */
export function quote(text) {
  return text
    .split("\n")
    .map((line) => `  ${dim(symbols.pipe)} ${line}`)
    .join("\n");
}
