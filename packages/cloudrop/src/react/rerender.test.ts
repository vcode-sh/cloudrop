// @vitest-environment happy-dom
// Contract (M11-R4, M11-R5): a hook follows the latest render without a remount. useUpload from another factory, as
// from a changed context, uploads through that factory's client and shows its list; an upload still running on the
// previous factory stays on its client, out of the new list and of the hook's controls. useResumable never shows the
// records of a route or a factory other than the render's.
// Oracle: the requests each fixture saw, the statuses the client reports, and the route of every record of every render.

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadHooks } from "../react.ts";
import { allowAnyone, route } from "../server/route.ts";
import { gate, partThree, reloaded } from "../testing/persist-fixture.ts";
import { fast, holdPut, hooksFixture, note, statuses } from "../testing/react-fixture.ts";

const routes = { notes: route({ accept: "text/plain", maxSize: 16, authorize: allowAnyone }) };
const done = ["POST /upload", "PUT object", "POST /complete"];

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useUpload from another factory, without a remount", () => {
  it.for([
    { name: "", wrapper: undefined },
    { name: " under StrictMode", wrapper: StrictMode },
  ])("uploads through the latest render's factory and lists the file$name", async ({ wrapper }) => {
    const [first, second] = [hooksFixture(routes), hooksFixture(routes)];
    const { result, rerender } = renderHook(({ hooks }) => hooks.useUpload("notes"), {
      initialProps: { hooks: first },
      wrapper,
    });
    rerender({ hooks: second });
    await act(() => result.current.upload(note("alpha", "a.txt")));

    expect({
      first: first.fixture.requests,
      second: second.fixture.requests,
      files: statuses(result.current.files),
    }).toEqual({ first: [], second: done, files: ["a.txt done"] });
  });

  it("leaves a running upload on the previous factory's client, out of the new list and of abort()", async () => {
    const held = holdPut(5);
    const [first, second] = [hooksFixture(routes, held.fault), hooksFixture(routes)];
    const { result, rerender } = renderHook(({ hooks }) => hooks.useUpload("notes"), {
      initialProps: { hooks: first },
    });
    let running: ReturnType<typeof result.current.upload> = Promise.resolve(null);
    act(() => {
      running = result.current.upload(note("alpha", "a.txt"));
    });
    await act(() => held.reached);
    rerender({ hooks: second });
    const onSecond = statuses(result.current.files);
    act(() => result.current.abort());
    held.open();
    const answer = await act(() => running);
    rerender({ hooks: first });

    expect({ onSecond, error: answer?.error, backOnFirst: statuses(result.current.files) }).toEqual({
      onSecond: [],
      error: null,
      backOnFirst: ["a.txt done"],
    });
  });
});

describe("useResumable with another route, without a remount", () => {
  // About 100 ms: the four-part file is 24 MiB, sent and checksummed in process.
  it("never shows the previous route's records", async () => {
    const setup = await reloaded(gate(partThree));
    const { useResumable } = createUploadHooks({ client: setup.client });
    const renders: { route: string; listed: string[] }[] = [];
    const { result, rerender } = renderHook(
      ({ name }) => {
        const resumable = useResumable(name);
        renders.push({ route: name, listed: resumable.uploads.map((upload) => upload.route) });
        return resumable;
      },
      { initialProps: { name: "files" } },
    );
    await waitFor(() => expect(result.current.uploads).toHaveLength(1), fast);
    rerender({ name: "avatars" });
    await act(() => result.current.refresh());
    rerender({ name: "files" });
    await waitFor(() => expect(result.current.uploads).toHaveLength(1), fast);

    expect(renders.filter(({ route, listed }) => listed.some((of) => of !== route))).toEqual([]);
    expect(renders.map(({ route }) => route)).toContain("avatars");
  });
});
