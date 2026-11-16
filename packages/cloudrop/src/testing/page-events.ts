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
  vi.stubGlobal("addEventListener", (type: string, listener: EventListenerOrEventListenerObject) => {
    held.push({ type, listener });
    target.addEventListener(type, listener);
  });
  vi.stubGlobal("removeEventListener", (type: string, listener: EventListenerOrEventListenerObject) => {
    held.splice(
      held.findIndex((entry) => entry.type === type && entry.listener === listener),
      1,
    );
    target.removeEventListener(type, listener);
  });
  return {
    fire: (type) => {
      target.dispatchEvent(new Event(type));
    },
    listening: () => held.map((entry) => entry.type).sort(),
  };
}
