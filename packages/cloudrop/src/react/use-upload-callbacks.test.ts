// @vitest-environment happy-dom
// Contract: spec 1.0 §1 (M12-H1 to M12-H3) through createUploadHooks on the real client and the fake server:
// `startError` holds the route's last start refused without a file row, set only by the latest start and cleared by
// the next one; `onError` hears every such refusal and every file that ends failed, with `error.file` set; `onUploaded`
// hears every file that ends done, on its first try or after retry(); a cancel is neither. Each hook hears each event
// that happened while it was mounted once, StrictMode included and even when that event unmounts it, from the latest
// render's options, and nothing that ended before it mounted.
// Oracle: the requests the fixture saw, the server's verdicts for the routes below and the outcomes the client
// resolves.

import { File as NodeFile } from "node:buffer";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { createElement, StrictMode, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudropError } from "../client.ts";
import type { UseUploadOptions } from "../react.ts";
import { forbidden } from "../server/refusal.ts";
import { allowAnyone, route } from "../server/route.ts";
import { failPut, fast, holdPut, hooksFixture, note, statuses } from "../testing/react-fixture.ts";

const routes = {
  notes: route({ accept: "text/plain", maxSize: 16, authorize: allowAnyone }),
  closed: route({ accept: "text/plain", maxSize: 16, authorize: () => forbidden() }),
};
type Fault = Parameters<typeof hooksFixture>[1];
type Options = UseUploadOptions<undefined>;

/** Hooks on the routes above, and what their callbacks heard, as "done a.txt" and "failed FORBIDDEN b.txt". */
function setup(fault?: Fault) {
  const hooks = hooksFixture(routes, fault);
  const heard: string[] = [];
  const options: Options = {
    onUploaded: (file) => heard.push(`done ${file.name}`),
    onError: (error) => heard.push(`failed ${error.code} ${error.file?.name ?? "-"}`),
  };
  return { ...hooks, heard, options };
}

/** A foreign File: the client refuses it with INVALID_INPUT before any file row exists (readFiles). */
const foreign = () => new NodeFile(["alpha"], "a.txt", { type: "text/plain" }) as unknown as File;

/** A file input on the notes route, and an output with the code of its startError. */
function Picker({ useUpload, options }: { useUpload: ReturnType<typeof setup>["useUpload"]; options: Options }) {
  const { getInputProps, startError } = useUpload("notes", options);
  return createElement(
    "div",
    null,
    createElement("input", { ...getInputProps(), "aria-label": "Files" }),
    createElement("output", null, startError?.code ?? "none"),
  );
}

type UseNotes = ReturnType<typeof setup>["useUpload"];

/** A hook on the notes route that shows `name` and logs each file it hears end done, as "leaving a.txt". */
function Listener({ useUpload, name, log }: { useUpload: UseNotes; name: string; log: string[] }) {
  useUpload("notes", { onUploaded: (file) => log.push(`${name} ${file.name}`) });
  return createElement("p", null, name);
}

/** A component that logs what its hooks hear and hands its upload() of a.txt to the test. */
type Starter = { useUpload: UseNotes; log: string[]; give: (upload: () => unknown) => void };

/** "leaving" until a file of the route is done, then "arriving" in its place. */
function Swap({ useUpload, log, give }: Starter) {
  const { totals, upload } = useUpload("notes");
  const given = useRef(false);
  if (!given.current) give(() => upload(note("alpha", "a.txt")));
  given.current = true;
  const name = totals.done === 0 ? "leaving" : "arriving";
  return createElement(Listener, { key: name, useUpload, name, log });
}

/** A hook on `route` that logs each file it hears end done, as "notes a.txt". */
function Follower({ useUpload, route, log }: { useUpload: UseNotes; route: "notes" | "closed"; log: string[] }) {
  useUpload(route, { onUploaded: (file) => log.push(`${route} ${file.name}`) });
  return createElement("p", null, route);
}

/** Moves its Follower, the same instance, from notes to closed once a file of notes is done. */
function Mover({ useUpload, log, give }: Starter) {
  const { totals, upload } = useUpload("notes", { onUploaded: (file) => log.push(`mover ${file.name}`) });
  const given = useRef(false);
  if (!given.current) give(() => upload(note("alpha", "a.txt")));
  given.current = true;
  return createElement(Follower, { useUpload, route: totals.done === 0 ? "notes" : "closed", log });
}

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  cleanup();
  vi.restoreAllMocks();
});

describe("useUpload's startError, onUploaded and onError", () => {
  it("shows a pick refused by a closed client in startError, sends nothing and calls onError once", async () => {
    const { fixture, close, useUpload, heard, options } = setup();
    const view = render(createElement(Picker, { useUpload, options }));
    await act(() => close());
    const input = view.getByLabelText("Files") as HTMLInputElement;
    const picked = new DataTransfer();
    picked.items.add(note("alpha", "a.txt"));
    input.files = picked.files;
    fireEvent.change(input);
    await waitFor(() => expect(view.container.querySelector("output")?.textContent).toBe("CLIENT_CLOSED"), fast);

    expect({ requests: fixture.requests, heard }).toEqual({ requests: [], heard: ["failed CLIENT_CLOSED -"] });
  });

  it("clears startError at the next start, and a refusal answered after a newer start does not set it", async () => {
    const { useUpload, heard, options } = setup();
    const { result } = renderHook(() => useUpload("notes", options));
    await act(() => result.current.upload(foreign()));
    const refused = result.current.startError?.code;
    await act(async () => {
      // Both start before the first one's refusal is read: only the latest start may set startError.
      const late = result.current.upload(foreign());
      await result.current.upload(note("bravo", "b.txt"));
      await late;
    });

    expect({ refused, after: result.current.startError, heard }).toEqual({
      refused: "INVALID_INPUT",
      after: null,
      // Every refusal is an event, even one that no longer sets startError.
      heard: ["failed INVALID_INPUT -", "failed INVALID_INPUT -", "done b.txt"],
    });
  });

  it("calls onError for a failed PUT, then onUploaded with retry()'s outcome once the retry is done", async () => {
    const broken = failPut(5);
    const hooks = hooksFixture(routes, broken.fault);
    const errors: CloudropError[] = [];
    const uploaded: unknown[] = [];
    const { result } = renderHook(() =>
      hooks.useUpload("notes", { onError: (error) => errors.push(error), onUploaded: (file) => uploaded.push(file) }),
    );
    await act(() => result.current.upload(note("alpha", "a.txt")));
    const id = result.current.files[0]?.id;
    broken.failing.on = false;
    const retried = await act(() => result.current.files[0]?.retry());
    await waitFor(() => expect(uploaded).toHaveLength(1), fast);

    expect({ errors: errors.map((error) => [error.code, error.file]), uploaded }).toEqual({
      errors: [["STORAGE_ERROR", { id, name: "a.txt" }]],
      uploaded: [retried],
    });
  });

  it("names the file in onError when the whole /upload was refused, once per file", async () => {
    const { useUpload, heard, options } = setup();
    const { result } = renderHook(() => useUpload("closed", { ...options, multiple: true }));
    await act(() => result.current.upload([note("alpha", "a.txt"), note("bravo", "b.txt")]));
    await waitFor(() => expect(heard).toHaveLength(2), fast);

    expect(heard).toEqual(["failed FORBIDDEN a.txt", "failed FORBIDDEN b.txt"]);
  });

  it("calls each callback once per event under StrictMode", async () => {
    const { useUpload, heard, options } = setup(failPut(6).fault);
    const { result } = renderHook(() => useUpload("notes", options), { wrapper: StrictMode });
    await act(() => result.current.upload(note("alpha", "a.txt")));
    await act(() => result.current.upload(note("bravo!", "b.txt")));
    await act(() => result.current.upload(foreign()));
    await waitFor(() => expect(heard).toHaveLength(3), fast);

    expect(heard).toEqual(["done a.txt", "failed STORAGE_ERROR b.txt", "failed INVALID_INPUT -"]);
  });

  it("reports nothing on a remount for a file that ended while no hook was mounted", async () => {
    const held = holdPut(5);
    const { useUpload, heard, options } = setup(held.fault);
    const first = renderHook(() => useUpload("notes", options));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = first.result.current.upload(note("alpha", "a.txt"));
    });
    await held.reached;
    first.unmount();
    held.open();
    await done;
    const { result } = renderHook(() => useUpload("notes", options));
    // Give a late report every chance to arrive: the events of a publish go out in a microtask.
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect({ files: statuses(result.current.files), heard }).toEqual({ files: ["a.txt done"], heard: [] });
  });

  it("lets a callback start another upload", async () => {
    const { useUpload, heard } = setup();
    const { result } = renderHook(() =>
      useUpload("notes", {
        onUploaded: (file) => {
          heard.push(`done ${file.name}`);
          if (file.name === "a.txt") void result.current.upload(note("bravo", "b.txt"));
        },
      }),
    );
    await act(() => result.current.upload(note("alpha", "a.txt")));
    await waitFor(() => expect(heard).toHaveLength(2), fast);

    expect({ files: statuses(result.current.files), heard }).toEqual({
      files: ["a.txt done", "b.txt done"],
      heard: ["done a.txt", "done b.txt"],
    });
  });

  it("calls the callbacks of every component on the route once, even when one of them throws", async () => {
    const { useUpload } = setup();
    const failure = new Error("the app's callback broke");
    const throwing = vi.fn(() => {
      throw failure;
    });
    const sender = renderHook(() => useUpload("notes", { onUploaded: throwing }));
    const reader = vi.fn();
    renderHook(() => useUpload("notes", { onUploaded: reader }));
    // A task with no delay is held here instead of run, so the test runs the rethrow itself; timers with a delay, the
    // client's and waitFor's, run as usual.
    const real = globalThis.setTimeout;
    const tasks: (() => void)[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((task: () => void, ...rest: [number?]) => {
      if (rest.length > 0) return real(task, ...rest);
      tasks.push(task);
      return 0;
    }) as typeof setTimeout);
    await act(() => sender.result.current.upload(note("alpha", "a.txt")));
    await waitFor(() => expect(reader).toHaveBeenCalledTimes(1), fast);
    expect(reader).toHaveBeenCalledTimes(1);

    // The throw goes to a task of its own, so it reaches the console and error reporting.
    expect(() => {
      for (const task of tasks) task();
    }).toThrow(failure);
    expect(throwing).toHaveBeenCalledTimes(1);
  });

  it("calls a hook that the file's end unmounts, and not one that the end mounts, when React renders outside act", async () => {
    const { useUpload } = setup();
    const log: string[] = [];
    let start: () => unknown = () => undefined;
    const view = render(createElement(Swap, { useUpload, log, give: (upload) => (start = upload) }));
    // Outside act React renders a store change, and runs its effects, in a microtask of its own as in a browser:
    // queued by the view's listeners, so before the callbacks' microtask.
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    await start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect({ shown: view.container.textContent, log }).toEqual({ shown: "arriving", log: ["leaving a.txt"] });
  });

  it("tells no callback of a route the end itself moved the hook to", async () => {
    const { useUpload } = setup();
    const log: string[] = [];
    let start: () => unknown = () => undefined;
    const view = render(createElement(Mover, { useUpload, log, give: (upload) => (start = upload) }));
    // As above: React renders the move before the callbacks' microtask runs.
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
    await start();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect({ shown: view.container.textContent, log }).toEqual({ shown: "closed", log: ["mover a.txt"] });
  });

  it("calls the latest render's onUploaded", async () => {
    const { useUpload } = setup();
    const before = vi.fn();
    const after = vi.fn();
    const { result, rerender } = renderHook(({ onUploaded }) => useUpload("notes", { onUploaded }), {
      initialProps: { onUploaded: before },
    });
    rerender({ onUploaded: after });
    await act(() => result.current.upload(note("alpha", "a.txt")));
    await waitFor(() => expect(after).toHaveBeenCalledTimes(1), fast);

    expect(before).not.toHaveBeenCalled();
  });

  it("calls neither callback for a cancelled file", async () => {
    const held = holdPut(5);
    const { useUpload, heard, options } = setup(held.fault);
    const { result } = renderHook(() => useUpload("notes", options));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.upload(note("alpha", "a.txt"));
    });
    await act(() => held.reached);
    act(() => result.current.abort());
    held.open();
    await act(() => done);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

    expect({ files: statuses(result.current.files), heard }).toEqual({ files: ["a.txt aborted"], heard: [] });
  });
});
