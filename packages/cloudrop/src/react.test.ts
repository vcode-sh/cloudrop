// @vitest-environment happy-dom
// Contract: the factory's close() (M7-P3, M8-L7) is the client's close() without a route list: it stops the uploads of
// every route the hooks started, and every upload afterwards resolves CLIENT_CLOSED before any request. It creates the
// client when no hook has yet, so a client closed before its first upload starts nothing either.
// Oracle: the statuses the client reports, the requests the fixture saw, literal error codes.

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowAnyone, route } from "./server/route.ts";
import { firstOf } from "./testing/persist-fixture.ts";
import { holdPut, hooksFixture, note, statuses } from "./testing/react-fixture.ts";

const routes = {
  avatar: route({ accept: "text/plain", maxSize: 16, authorize: allowAnyone }),
  notes: route({ accept: "text/plain", maxSize: 16, authorize: allowAnyone }),
};

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("createUploadHooks().close()", () => {
  it("stops the uploads of every route, and an upload afterwards resolves CLIENT_CLOSED unsent", async () => {
    const [avatar, notes] = [holdPut(5), holdPut(6)];
    const { fixture, useUpload, close } = hooksFixture(routes, firstOf(avatar.fault, notes.fault));
    const { result } = renderHook(() => ({ avatar: useUpload("avatar"), notes: useUpload("notes") }));
    const running = act(() =>
      Promise.all([
        result.current.avatar.upload(note("hello", "a.txt")),
        result.current.notes.upload(note("hello!", "b.txt")),
      ]),
    );
    await Promise.all([avatar.reached, notes.reached]);
    await act(() => close({ abort: true }));
    await running;
    const sent = fixture.requests.length;
    const after = await act(() => result.current.notes.upload(note("again", "c.txt")));

    expect({
      avatar: statuses(result.current.avatar.files),
      notes: statuses(result.current.notes.files),
      after: after?.error?.code,
      sentAfter: fixture.requests.slice(sent),
    }).toEqual({ avatar: ["a.txt aborted"], notes: ["b.txt aborted"], after: "CLIENT_CLOSED", sentAfter: [] });
  });

  it("closes a client no hook has created yet", async () => {
    const { fixture, useUpload, close } = hooksFixture(routes);
    close();
    const { result } = renderHook(() => useUpload("notes"));
    const answer = await act(() => result.current.upload(note("hello", "a.txt")));

    expect({ code: answer?.error?.code, requests: fixture.requests }).toEqual({ code: "CLIENT_CLOSED", requests: [] });
  });
});
