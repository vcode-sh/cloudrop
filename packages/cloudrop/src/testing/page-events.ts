// The page's global events for the client's unit tests: an EventTarget stubbed as the global addEventListener and
// removeEventListener, so a test fires offline, online or pagehide and sees which listeners the client holds.

import { vi } from "vitest";

export interface PageEvents {
  fire(type: "offline" | "online" | "pagehide"): void;
  /** The event types listened for now, sorted, one entry per listener. */
  listening(): string[];
}

/** Stubs the globals until the test calls vi.unstubAllGlobals(). */
export function pageEvents(): PageEvents {
  const target = new EventTarget();
  const held: { type: string; listener: EventListenerOrEventListenerObject }[] = [];
  const indexOf = (type: string, listener: EventListenerOrEventListenerObject) =>
    held.findIndex((entry) => entry.type === type && entry.listener === listener);
  // As a page does: the same listener is added once, and removing one that is not held does nothing.
  vi.stubGlobal("addEventListener", (type: string, listener: EventListenerOrEventListenerObject) => {
    if (indexOf(type, listener) === -1) held.push({ type, listener });
    target.addEventListener(type, listener);
  });
  vi.stubGlobal("removeEventListener", (type: string, listener: EventListenerOrEventListenerObject) => {
    const at = indexOf(type, listener);
    if (at !== -1) held.splice(at, 1);
    target.removeEventListener(type, listener);
  });
  return {
    fire: (type) => {
      target.dispatchEvent(new Event(type));
    },
    listening: () => held.map((entry) => entry.type).sort(),
  };
}
