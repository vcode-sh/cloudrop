// Contract: spec §2.1 (the snapshot is the same object until something changes; listeners at most every 100 ms while
// bytes flow and at once on a status change) and rulings P7 (a refresh every second while a file uploads, nothing
// scheduled once none does) and P8 (a throwing listener stops nothing and is re-thrown from a timer).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

/** A store whose snapshots are numbered, so a new object is observable, and whose `active()` the test controls. */
function counted(active = () => false) {
  let counter = 0;
  const store = createStore(() => ({ n: ++counter }), active);
  const listener = vi.fn();
  store.subscribe(listener);
  return { store, listener };
}

describe("createStore", () => {
  it("returns the same snapshot until a publish, then a new one", () => {
    const { store } = counted();
    const first = store.get();
    expect(store.get()).toBe(first);
    store.changed(true);
    expect(store.get()).not.toBe(first);
    expect(store.get()).toEqual({ n: 2 });
  });

  it("publishes byte changes at most every 100 ms", () => {
    const { store, listener } = counted();
    store.changed(true);
    listener.mockClear();
    store.changed(false);
    vi.advanceTimersByTime(10);
    store.changed(false);
    vi.advanceTimersByTime(20);
    store.changed(false);
    vi.advanceTimersByTime(69);
    expect(listener).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("publishes a status change at once and drops the pending byte publish", () => {
    const { store, listener } = counted();
    store.changed(true);
    vi.advanceTimersByTime(10);
    store.changed(false);
    vi.advanceTimersByTime(10);
    listener.mockClear();
    store.changed(true);
    expect(listener).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("refreshes every second while active and leaves no timer once it is not", () => {
    let uploading = true;
    const { store, listener } = counted(() => uploading);
    store.changed(true);
    vi.advanceTimersByTime(999);
    expect(listener).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(listener).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(listener).toHaveBeenCalledTimes(3);
    uploading = false;
    store.changed(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("publishes byte changes 100 ms after the last publish while a refresh is pending", () => {
    const { store, listener } = counted(() => true);
    store.changed(true);
    vi.advanceTimersByTime(10);
    store.changed(false);
    vi.advanceTimersByTime(90);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("calls the other listeners when one throws and re-throws its error later", () => {
    const { store, listener } = counted();
    store.subscribe(() => {
      throw new Error("listener failed");
    });
    const after = vi.fn();
    store.subscribe(after);
    store.changed(true);
    expect(listener).toHaveBeenCalledOnce();
    expect(after).toHaveBeenCalledOnce();
    expect(() => vi.runOnlyPendingTimers()).toThrow("listener failed");
  });

  it("stops calling a listener once its unsubscribe runs", () => {
    const { store, listener } = counted();
    const removed = vi.fn();
    const unsubscribe = store.subscribe(removed);
    unsubscribe();
    store.changed(true);
    expect(removed).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
  });
});
