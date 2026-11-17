// The page's events that reach a job: connectivity while a file runs (spec §4.6, rulings M3-U28, M3-U39 and M3-U48),
// and pagehide while a failed file holds its ticket (spec §4.7, M3-U33).

import type { Entry } from "./entry.ts";
import type { Upload } from "./upload.ts";

/**
 * Calls `offline` and `online` on the page's connectivity events until the returned function runs, and one of them at
 * once for where the page is now: an `online` that came while nobody listened must still resume what `offline` paused.
 * A no-op where the global has no addEventListener (Node); Deno and Workers have one and never fire these events, which
 * is harmless.
 */
export function watchConnectivity(offline: () => void, online: () => void): () => void {
  // Without listeners no `online` would ever resume what an early `offline` paused.
  if (typeof globalThis.addEventListener !== "function") return () => {};
  addEventListener("offline", offline);
  addEventListener("online", online);
  if (globalThis.navigator?.onLine === false) offline();
  else online();
  return () => {
    removeEventListener("offline", offline);
    removeEventListener("online", online);
  };
}

/** Gives failed files' tickets up when the page hides: one pagehide listener while any is held (M3-U33). */
export interface Leftovers {
  hold(entry: Entry): void;
  release(entry: Entry): void;
}

/** `entry`'s upload while its ticket lasts; after that the bucket's lifecycle rule removes it (spec §4.7, M3-U33). */
function unexpired({ upload }: Entry) {
  return upload && Date.parse(upload.ticket.expiresAt) > Date.now() ? upload : null;
}

/**
 * On pagehide, calls `giveUp` (file-run.ts: the ticket marked dropped, so a retry after a back-forward cache restore
 * asks for a new one; a keepalive /abort unless a reload can resume it, M4-F1) for every held ticket that has not
 * expired. Expired tickets are let go on pagehide and on hold.
 */
export function createLeftovers(giveUp: (upload: Upload) => void): Leftovers {
  const held = new Set<Entry>();
  // The page adds the same listener once, and removing one it does not hold does nothing.
  const sync = () => {
    for (const entry of held) if (!unexpired(entry)) held.delete(entry);
    // No page hides where the global has no addEventListener (Node).
    if (typeof globalThis.addEventListener !== "function") return;
    if (held.size > 0) addEventListener("pagehide", pagehide);
    else removeEventListener("pagehide", pagehide);
  };
  function pagehide() {
    for (const entry of held) {
      const upload = unexpired(entry);
      if (upload) giveUp(upload);
    }
    held.clear();
    sync();
  }
  return {
    hold(entry) {
      held.add(entry);
      sync();
    },
    release(entry) {
      held.delete(entry);
      sync();
    },
  };
}
