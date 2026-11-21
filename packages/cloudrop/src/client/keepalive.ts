// How much of the browser's keepalive allowance one client uses (M11-R87). A browser caps the keepalive request bodies
// a document has in flight at 64 KiB together and fails each request beyond that unsent: 65,536 bytes exactly in
// Chromium, measured with spikes/keepalive/measure.mjs.

/** What one client's keepalive bodies in flight may add up to; 8 KiB of the cap are left for the page's own beacons. */
const KEEPALIVE_BUDGET_BYTES = 56 * 1024;

export interface KeepaliveBudget {
  /**
   * Counts a request body of `bytes` bytes as in flight when the request `wants` keepalive and the budget has room, and
   * answers the bytes counted: 0 means the request goes without keepalive.
   */
  take(wants: boolean | undefined, bytes: number): number;
  /** Gives back what take() answered, once the request's answer was read or it failed. */
  give(bytes: number): void;
}

export function createKeepaliveBudget(): KeepaliveBudget {
  let inFlight = 0;
  return {
    take(wants, bytes) {
      if (!wants || inFlight + bytes > KEEPALIVE_BUDGET_BYTES) return 0;
      inFlight += bytes;
      return bytes;
    },
    give(bytes) {
      inFlight -= bytes;
    },
  };
}
