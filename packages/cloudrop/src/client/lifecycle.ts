// The page's events that reach a running job: connectivity (spec §4.6, plan B rulings Q6 and Q17).

/**
 * Calls `offline` and `online` on the page's connectivity events until the returned function runs, and `offline` at
 * once when the page is already offline. A no-op where the global has no addEventListener (Node); Deno and Workers
 * have one and never fire these events, which is harmless.
 */
export function watchConnectivity(offline: () => void, online: () => void): () => void {
  // Without listeners no `online` would ever resume what an early `offline` paused.
  if (typeof globalThis.addEventListener !== "function") return () => {};
  addEventListener("offline", offline);
  addEventListener("online", online);
  if (globalThis.navigator?.onLine === false) offline();
  return () => {
    removeEventListener("offline", offline);
    removeEventListener("online", online);
  };
}
