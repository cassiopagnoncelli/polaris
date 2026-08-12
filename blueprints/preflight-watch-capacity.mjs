// Refuse to start a blueprint when the machine has no file-watch capacity left.
//
// Every `tsx watch` supervisor in a bare-metal dev stack holds its own kqueue
// watches, and macOS hands out a finite number of them per machine. `make
// dev-all` starts one supervisor per app, processor and consumer — fourteen of
// them on a full checkout — and that is enough, on its own, to leave nothing
// for a fifteenth watcher.
//
// The fifteenth watcher is this blueprint. What a developer sees when it
// loses is not "out of watches": libuv reports the failed
// `FSEventStreamStart` as EMFILE, Watchpack reads the dead watcher as a
// deleted `.next/dev`, and Next.js restarts to recover — into the same
// failure, forever. Nothing in that loop names the dev stack, so the search
// starts in the wrong repo. It reads like the blueprint broke, and the last
// thing that touched it gets the blame — usually whatever install ran most
// recently.
//
// So probe the real resource rather than guess at it: open a handful of
// watches and see whether the OS honours them. Counting `tsx watch` processes
// would be cheaper and wrong, because the watchers that push a machine over
// the edge are frequently not Polaris's at all — any other checkout with a
// dev server running spends from the same budget.
//
// A real application installing `@polaris/web-sdk` from the internal registry
// needs none of this. It exists because the blueprints live in the monorepo
// whose dev stack starves them.

import { watch } from "node:fs";

/**
 * Watches opened per round.
 *
 * Eight is above what a single `next dev` needs at rest and far below anything
 * a healthy machine strains at, so a round that fails here is a machine that
 * cannot run the blueprint.
 */
const WATCHES_PER_ROUND = 8;

/**
 * Rounds to run.
 *
 * libuv rebuilds one FSEvents stream covering every watched path each time a
 * handle is added, so failures arrive per-batch and a single round can come
 * back clean on a machine that is genuinely out of capacity. Rounds are cheap;
 * more of them mostly costs the settle time below.
 */
const ROUNDS = 3;

/** Milliseconds to wait for errors, which arrive on the handle, not the call. */
const SETTLE_MS = 250;

const TARGET = process.cwd();

/**
 * Open `WATCHES_PER_ROUND` watches, wait for the OS to reject them, close.
 *
 * Resolves to the error code that came back, or `undefined` when every watch
 * held. `watch()` succeeds synchronously and reports the failure later on the
 * handle's `error` event, so the wait is not optional.
 */
function probeRound() {
  return new Promise((resolve) => {
    const handles = [];
    let failure;

    for (let i = 0; i < WATCHES_PER_ROUND; i++) {
      try {
        const handle = watch(TARGET, { persistent: false });
        handle.on("error", (error) => {
          failure ??= error.code;
        });
        handles.push(handle);
      } catch (error) {
        // A synchronous throw is the same shortage, reported earlier.
        failure ??= error.code;
      }
    }

    setTimeout(() => {
      for (const handle of handles) {
        try {
          handle.close();
        } catch {
          // Closing a handle the OS already tore down is not interesting.
        }
      }
      resolve(failure);
    }, SETTLE_MS);
  });
}

async function main() {
  for (let round = 0; round < ROUNDS; round++) {
    const failure = await probeRound();
    if (failure === undefined) continue;

    console.error(
      `\nThis machine is out of file-watch capacity (${failure}).\n\n` +
        "  Next.js needs to watch files to run in dev. It cannot here, and it\n" +
        "  does not fail cleanly when it cannot: it reports `.next/dev` as\n" +
        "  deleted and restarts, over and over. Stopping before that starts.\n\n" +
        "  Something on this machine is holding the watches — most often a\n" +
        "  bare-metal Polaris stack, since `make dev-all` runs one `tsx watch`\n" +
        "  per service:\n\n" +
        "    make dev-stop\n\n" +
        "  The blueprint only needs the ingester, so start the small stack instead\n" +
        "  and leave the rest stopped:\n\n" +
        "    make dev-ingester\n\n" +
        "  If no Polaris stack is running, the watchers belong to another\n" +
        "  checkout — dev servers in other repos spend the same budget. Stop\n" +
        "  one and try again.\n",
    );
    process.exit(1);
  }
}

await main();
