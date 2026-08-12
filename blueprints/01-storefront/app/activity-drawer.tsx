"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { clearFeed, getFeed, getServerFeed, subscribeToFeed } from "../lib/feed";

/** The bare key that opens and closes the drawer. */
const TOGGLE_KEY = "a";

/**
 * Whether a keystroke is already spoken for by whatever has focus.
 *
 * A single-letter shortcut is only safe while nobody is typing, and the
 * event's own target answers that: a `keydown` is dispatched to the focused
 * element, so a field that wants the letter is the thing reporting it. A
 * `select` counts — letters jump between its options.
 */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Everything the blueprint has seen, newest first, in a drawer pinned to the
 * bottom of every page — so the feed stays put while you navigate, and the
 * page above it is free to be a page.
 *
 * Lines are tagged by producer: `web` for the browser SDK's own diagnostics,
 * `server` for what a Server Action or route handler reported back, and `ui`
 * for interactions that produced no event at all.
 *
 * The `web` lines are the SDK's diagnostic callbacks verbatim:
 * `onDiagnostic`, `onFlush`, `onDrop`, `onError`. The SDK never phones these
 * home and has no opinion about them — they are handed to whatever you pass
 * in. Here that is a module-level store feeding this list; in your app it
 * would be your logger or metrics client.
 *
 * `a` toggles it from anywhere on the page, so the feed can be pulled up
 * after a click and pushed away again without leaving the keyboard.
 */
export function ActivityDrawer() {
  const feed = useSyncExternalStore(subscribeToFeed, getFeed, getServerFeed);
  // Open by default: watching this list is the point of the blueprint. The
  // state lives in the layout, so it survives client-side navigation.
  const [open, setOpen] = useState(true);

  // Bound to the window rather than to the drawer, because the point of the
  // shortcut is reaching the drawer from a page that has focus.
  //
  // A bare `a` only: every modifier combination belongs to the browser or the
  // OS — ⌘A selects the page — and taking one of those would cost more than
  // the shortcut is worth. `shiftKey` is checked rather than the key's case so
  // that Caps Lock, which reports `A` for an unshifted press, still toggles.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (event.key.toLowerCase() !== TOGGLE_KEY) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.defaultPrevented || isTypingTarget(event.target)) return;
      // Firefox's find-as-you-type would otherwise start a search on the key.
      event.preventDefault();
      setOpen((current) => !current);
    }

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const latest = feed[0];

  return (
    <aside className="drawer" data-open={open} aria-label="Activity">
      <div className="drawer-head">
        <button
          type="button"
          className="drawer-toggle"
          aria-expanded={open}
          aria-controls="activity-body"
          aria-keyshortcuts={TOGGLE_KEY}
          onClick={() => setOpen((current) => !current)}
        >
          <span className="drawer-chevron" aria-hidden="true">
            ▾
          </span>
          <span className="drawer-label">Activity</span>
          <span className="drawer-count">{feed.length}</span>
          {/* The shortcut, shown rather than documented — nobody presses a key
              they were never told about. Hidden from assistive tech because
              `aria-keyshortcuts` above already announces it, and folded into
              the button's name it would just be a stray letter. */}
          {/* biome-ignore lint/a11y/noAriaHiddenOnFocusable: kbd is not focusable */}
          <kbd className="drawer-key" aria-hidden="true">
            {TOGGLE_KEY}
          </kbd>
          {!open && (
            <span className="drawer-peek">
              {latest === undefined ? (
                "nothing yet — navigate, or press a button"
              ) : (
                <>
                  <span className={`tag tag-${latest.channel}`}>{latest.channel}</span>
                  {latest.text}
                </>
              )}
            </span>
          )}
        </button>
        <button
          type="button"
          className="drawer-clear"
          disabled={feed.length === 0}
          onClick={clearFeed}
        >
          clear
        </button>
      </div>

      <div className="drawer-body" id="activity-body">
        {feed.length === 0 ? (
          <p className="muted drawer-empty">
            Nothing yet. Navigate, or press a button — every SDK diagnostic, every event, and every
            click lands here.
          </p>
        ) : (
          <ul className="feed">
            {feed.map((entry) => (
              <li key={entry.id}>
                <time>{entry.at}</time>
                <span className={`tag tag-${entry.channel}`}>{entry.channel}</span>
                <span>{entry.text}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
