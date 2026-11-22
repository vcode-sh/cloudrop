// @vitest-environment happy-dom
// Contract: spec §6.1 (M4-B1, M4-B2, M4-B4) through createUploadHooks on the real client and the fake server: each
// file's controls act on that file and the hook's on every job; upload(null) starts nothing, and upload() passes what
// it gets to the client, which checks it is a File; a wrong client option resolves INVALID_CONFIG; upload() reads the
// latest options; the input clears after a pick; StrictMode duplicates nothing. What the hook renders:
// upload-store.test.ts.
// Oracle: the requests the fixture saw, the server's verdicts for the routes below and the statuses the client reports.

import { File as NodeFile } from "node:buffer";
import { act, cleanup, fireEvent, render, renderHook, waitFor } from "@testing-library/react";
import { createElement, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCloudropClient, type InferableCloudrop } from "../client.ts";
import { createUploadHooks, type UploadHooks } from "../react.ts";
import { allowAnyone, route } from "../server/route.ts";
import type { StandardSchema } from "../server/schema.ts";
import { clientFixture, type Fault } from "../testing/client-fixture.ts";
import { firstOf, gate } from "../testing/persist-fixture.ts";
import { failPut, fast, holdPut, hooksFixture, note, statuses } from "../testing/react-fixture.ts";
import type { UploadItem } from "./types.ts";

const tagged: StandardSchema<{ tag: string }> = {
  "~standard": { version: 1, vendor: "test", validate: (value) => ({ value: value as { tag: string } }) },
};
const routes = {
  notes: route({ accept: "text/plain", maxSize: 16, authorize: allowAnyone }),
  tagged: route(
    { accept: "text/plain", maxSize: 16, metadata: tagged, authorize: allowAnyone },
    { onComplete: ({ metadata }) => metadata },
  ),
};

const setup = (fault?: Fault) => hooksFixture(routes, fault);
const count = (requests: string[], label: string) => requests.filter((request) => request === label).length;

/** A file input that takes several text files, and an output listing the hook's files. */
function Picker({ useUpload }: { useUpload: UploadHooks<InferableCloudrop>["useUpload"] }) {
  const { files, getInputProps } = useUpload("notes", { multiple: true, accept: "text/plain" });
  return createElement(
    "div",
    null,
    createElement("input", { ...getInputProps(), "aria-label": "Files" }),
    createElement("output", null, statuses(files).join(", ")),
  );
}

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.restoreAllMocks();
});

describe("useUpload", () => {
  it("resolves null for no file or an empty list, and sends nothing", async () => {
    const { fixture, useUpload } = setup();
    const { result } = renderHook(() => useUpload("notes"));
    const answers = await act(() => Promise.all([result.current.upload(null), result.current.upload([])]));

    expect({ answers, files: result.current.files, requests: fixture.requests }).toEqual({
      answers: [null, null],
      files: [],
      requests: [],
    });
  });

  it("passes a File of another realm to the client, which refuses it as INVALID_INPUT", async () => {
    const { fixture, useUpload } = setup();
    const { result } = renderHook(() => useUpload("notes"));
    // Node's File is not this window's File, as one from an iframe is not: `instanceof File` is false for both.
    const foreign = new NodeFile(["alpha"], "a.txt", { type: "text/plain" }) as unknown as File;
    const answer = await act(() => result.current.upload(foreign));

    expect({ answer: answer?.data, code: answer?.error?.code, requests: fixture.requests }).toEqual({
      answer: null,
      code: "INVALID_INPUT",
      requests: [],
    });
  });

  // The client's job for a refused start() has no file (client/job.ts): nothing to list, retry or read the list for.
  it("keeps nothing of an upload refused before it starts: no file, and no new read of the resumable list", async () => {
    const fixture = clientFixture(routes);
    const client = createCloudropClient({ basePath: fixture.basePath, fetch: fixture.fetch, persist: false });
    const reads = vi.spyOn(client, "resumable");
    const { useUpload, useResumable } = createUploadHooks({ client });
    const { result } = renderHook(() => ({ hook: useUpload("notes"), resumable: useResumable() }));
    await act(() => client.close());
    const before = reads.mock.calls.length;
    const refused = await act(() => result.current.hook.upload(note("alpha", "a.txt")));

    expect({
      code: refused?.error?.code,
      files: result.current.hook.files,
      reads: reads.mock.calls.length - before,
    }).toEqual({ code: "CLIENT_CLOSED", files: [], reads: 0 });
  });

  it("throws a wrong client option in a task when a pick has no caller to resolve to", () => {
    // No leading slash: createCloudropClient refuses this basePath (readOptions in client.ts).
    const { useUpload } = createUploadHooks({ basePath: "api/cloudrop" });
    const view = render(createElement(Picker, { useUpload }));
    const input = view.getByLabelText("Files") as HTMLInputElement;
    const picked = new DataTransfer();
    picked.items.add(note("alpha", "a.txt"));
    input.files = picked.files;
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    fireEvent.change(input);

    expect(() => vi.runOnlyPendingTimers()).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });

  it("resolves INVALID_CONFIG from upload(), resume() and refresh() when the client's options are wrong", async () => {
    // No leading slash: createCloudropClient refuses this basePath (readOptions in client.ts).
    const { useUpload, useResumable } = createUploadHooks({ basePath: "api/cloudrop" });
    const { result } = renderHook(() => ({ hook: useUpload("notes"), resumable: useResumable() }));
    const record = {
      id: "01M7M9TNBPHGF4ET6BM935W02V",
      route: "notes" as const,
      name: "a.txt",
      size: 5,
      type: "text/plain",
      lastModified: 0,
      expiresAt: "2026-11-18T00:00:00.000Z",
    };
    const answers = await act(() =>
      Promise.all([
        result.current.hook.upload(note("alpha", "a.txt")),
        result.current.hook.resumeUpload(record, note("alpha", "a.txt")),
        result.current.resumable.refresh(),
      ]),
    );

    expect({
      answers: answers.map((answer) => [answer?.data, answer?.error?.code]),
      files: result.current.hook.files,
      uploads: result.current.resumable.uploads,
    }).toEqual({
      answers: [
        [null, "INVALID_CONFIG"],
        [null, "INVALID_CONFIG"],
        [null, "INVALID_CONFIG"],
      ],
      files: [],
      uploads: [],
    });
  });

  it("binds each file's pause, resume, abort and retry to that file", async () => {
    const held = holdPut(5);
    const broken = failPut(6);
    const { useUpload } = setup(firstOf(held.fault, broken.fault));
    const { result } = renderHook(() => useUpload("notes", { multiple: true }));
    act(() => {
      void result.current.upload([note("alpha", "a.txt"), note("bravo!", "b.txt")]);
    });
    await waitFor(() => expect(statuses(result.current.files)).toEqual(["a.txt uploading", "b.txt failed"]), fast);
    const steps: string[][] = [];
    /** Runs `action` on the files of the latest render, then waits for `expected` and records it. */
    const step = async (action: (files: readonly UploadItem<unknown>[]) => unknown, expected: string[]) => {
      act(() => void action(result.current.files));
      await waitFor(() => expect(statuses(result.current.files)).toEqual(expected), fast);
      steps.push(statuses(result.current.files));
    };

    broken.failing.on = false;
    await step(([, b]) => b?.retry(), ["a.txt uploading", "b.txt done"]);
    await step(([a]) => a?.pause(), ["a.txt paused", "b.txt done"]);
    // The gate holds the resumed PUT too.
    await step(([a]) => a?.resume(), ["a.txt uploading", "b.txt done"]);
    await step(([a]) => a?.abort(), ["a.txt aborted", "b.txt done"]);

    expect(steps).toEqual([
      ["a.txt uploading", "b.txt done"],
      ["a.txt paused", "b.txt done"],
      ["a.txt uploading", "b.txt done"],
      ["a.txt aborted", "b.txt done"],
    ]);
  });

  it("pauses, resumes and aborts every job of the hook", async () => {
    const held = gate((call) => call.label === "PUT object" && (call.init.body as Blob).size < 7);
    const broken = failPut(7);
    const { useUpload } = setup(firstOf(held.fault, broken.fault));
    const { result } = renderHook(() => useUpload("notes"));
    act(() => {
      void result.current.upload(note("alpha", "a.txt"));
      void result.current.upload(note("bravo!", "b.txt"));
      void result.current.upload(note("charlie", "c.txt"));
    });
    const seen: string[][] = [];
    const settle = async (expected: string[]) => {
      await waitFor(() => expect(statuses(result.current.files)).toEqual(expected), fast);
      seen.push(statuses(result.current.files));
    };
    await settle(["a.txt uploading", "b.txt uploading", "c.txt failed"]);
    act(() => result.current.pause());
    await settle(["a.txt paused", "b.txt paused", "c.txt failed"]);
    act(() => result.current.resume());
    await settle(["a.txt uploading", "b.txt uploading", "c.txt failed"]);
    act(() => result.current.abort());
    await settle(["a.txt aborted", "b.txt aborted", "c.txt aborted"]);

    expect(seen).toEqual([
      ["a.txt uploading", "b.txt uploading", "c.txt failed"],
      ["a.txt paused", "b.txt paused", "c.txt failed"],
      ["a.txt uploading", "b.txt uploading", "c.txt failed"],
      // A failed file ends aborted too (FileHandle.abort).
      ["a.txt aborted", "b.txt aborted", "c.txt aborted"],
    ]);
  });

  it("retries the failed files of every job of the hook", async () => {
    const broken = failPut(5);
    const { useUpload } = setup(broken.fault);
    const { result } = renderHook(() => useUpload("notes"));
    await act(() => result.current.upload(note("alpha", "a.txt")));
    await act(() => result.current.upload(note("other", "b.txt")));
    broken.failing.on = false;
    await act(() => result.current.retry());

    expect(statuses(result.current.files)).toEqual(["a.txt done", "b.txt done"]);
  });

  it("sends the latest render's metadata unless the call passes its own, and keeps every control's identity", async () => {
    const { useUpload } = setup();
    const { result, rerender } = renderHook(({ tag }) => useUpload("tagged", { metadata: { tag } }), {
      initialProps: { tag: "first" },
    });
    const controls = ["upload", "pause", "resume", "abort", "retry", "clear", "getInputProps", "getDropProps"] as const;
    const before = controls.map((name) => result.current[name]);
    rerender({ tag: "second" });
    const changed = controls.filter((name, at) => result.current[name] !== before[at]);
    const fromHook = await act(() => result.current.upload(note("alpha", "a.txt")));
    const fromCall = await act(() => result.current.upload(note("bravo", "b.txt"), { metadata: { tag: "call" } }));

    const dataOf = (answer: typeof fromHook) =>
      answer?.data?.files[0]?.status === "done" ? answer.data.files[0].result.data : null;
    // An effect that lists a control in its dependencies must not run again on every render (M4-B2).
    expect({ changed, data: [dataOf(fromHook), dataOf(fromCall)] }).toEqual({
      changed: [],
      data: [{ tag: "second" }, { tag: "call" }],
    });
  });

  it("uploads what the input picked and clears it, so that picking the same file again uploads it again", async () => {
    const { fixture, useUpload } = setup();
    const view = render(createElement(Picker, { useUpload }));
    const input = view.getByLabelText("Files") as HTMLInputElement;
    const file = note("alpha", "a.txt");
    const pick = () => {
      const picked = new DataTransfer();
      picked.items.add(file);
      input.files = picked.files;
      fireEvent.change(input);
      return input.value;
    };

    const values = [pick()];
    await waitFor(() => expect(view.container.querySelector("output")?.textContent).toBe("a.txt done"), fast);
    values.push(pick());
    await waitFor(
      () => expect(view.container.querySelector("output")?.textContent).toBe("a.txt done, a.txt done"),
      fast,
    );

    expect({
      attributes: [input.type, input.multiple, input.accept],
      values,
      uploads: count(fixture.requests, "POST /upload"),
    }).toEqual({ attributes: ["file", true, "text/plain"], values: ["", ""], uploads: 2 });
  });

  it("sends one /upload for one upload() under StrictMode, and lists the file once", async () => {
    const { fixture, useUpload } = setup();
    const { result } = renderHook(() => useUpload("notes"), { wrapper: StrictMode });
    await act(() => result.current.upload(note("alpha", "a.txt")));

    expect({ requests: fixture.requests, files: statuses(result.current.files) }).toEqual({
      requests: ["POST /upload", "PUT object", "POST /complete"],
      files: ["a.txt done"],
    });
  });
});
