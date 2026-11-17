// @vitest-environment happy-dom
// Contract: spec §6.1 and §6.2 (M4-B2, M4-B3, M4-B12): useResumable lists the client's resumable() without the uploads
// this page holds through the hooks (running, paused, failed and waiting for retry(), or being resumed), read after
// mount, when a job starts and whenever one of its files ends or starts again; `[]` before the first read.
// useUpload's resume(upload, file) continues a record into that hook's `files`; refresh() reads again and resolves with
// the listed Result.
// Oracle: the page before the reload (persist-fixture's reloaded(): a four-part upload interrupted after two parts)
// leaves exactly one record; a failed multipart file of start() keeps its record for retry(), and a file that ends done
// deletes it (resume spec §2, client/persist.ts); the client's own resumable() is what the browser keeps.

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createUploadHooks } from "../react.ts";
import type { Fault } from "../testing/client-fixture.ts";
import { errorResponse } from "../testing/fake-r2/responses.ts";
import { fourParts, gate, nth, partThree, persistFixture, reloaded, threeParts } from "../testing/persist-fixture.ts";
import { fast } from "../testing/react-fixture.ts";

const ids = (uploads: readonly { id: string }[] | null | undefined) => uploads?.map(({ id }) => id);

/** Every attempt at the PUT `label` (from its `fromNth` call on) fails while `failing.on`: the file ends failed. */
function failing(label: string, fromNth = 1) {
  const failing = { on: true };
  const fault: Fault = (call) =>
    failing.on && call.label === label && call.nth >= fromNth
      ? errorResponse(500, "InternalError", "We encountered an internal error. Please try again.")
      : undefined;
  return { failing, fault };
}

beforeEach(() => {
  // Every backoff wait becomes 0 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useResumable", () => {
  // About 100 ms: the four-part file is 24 MiB, sent and checksummed in process.
  it("lists the upload left before the reload, resumes it into files, and lists nothing once it is done", async () => {
    const setup = await reloaded(gate(partThree));
    const { useUpload, useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => ({ hook: useUpload("files"), resumable: useResumable("files") }));
    const beforeRead = result.current.resumable.uploads;
    await waitFor(() => expect(result.current.resumable.uploads.map(({ id }) => id)).toEqual([setup.upload.id]), fast);
    const [record] = result.current.resumable.uploads;
    if (!record) throw new Error("useResumable listed no upload.");

    const answer = await act(() => result.current.hook.resume(record, fourParts()));
    await setup.drained();
    await waitFor(() => expect(result.current.resumable.uploads).toEqual([]), fast);

    expect({
      beforeRead,
      error: answer.error,
      files: result.current.hook.files.map((file) => `${file.name} ${file.status}`),
    }).toEqual({ beforeRead: [], error: null, files: ["b.bin done"] });
  });

  it("refresh() reads the list again and resolves with the client's answer", async () => {
    const setup = await reloaded(gate(partThree));
    const { useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => useResumable());
    await waitFor(() => expect(result.current.uploads).toHaveLength(1), fast);
    await setup.client.forget();

    const answer = await act(() => result.current.refresh());

    expect({ answer, uploads: result.current.uploads }).toEqual({ answer: { data: [], error: null }, uploads: [] });
  });

  it("hides a listed upload while its own resume runs", async () => {
    const resumedPart = gate(nth("PUT part 3", 2));
    const setup = await reloaded(gate(partThree), resumedPart.fault);
    const { useUpload, useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => ({ hook: useUpload("files"), resumable: useResumable("files") }));
    await waitFor(() => expect(ids(result.current.resumable.uploads)).toEqual([setup.upload.id]), fast);
    const [record] = result.current.resumable.uploads;
    if (!record) throw new Error("useResumable listed no upload.");

    let resumed: Promise<unknown> = Promise.resolve();
    act(() => {
      resumed = result.current.hook.resume(record, fourParts());
    });
    await act(() => resumedPart.reached);
    await waitFor(() => expect(result.current.resumable.uploads).toEqual([]), fast);
    const whileRunning = {
      status: result.current.hook.files[0]?.status,
      kept: ids((await setup.client.resumable()).data),
    };
    resumedPart.open();
    await act(() => resumed);
    await setup.drained();

    expect({ whileRunning, after: result.current.resumable.uploads }).toEqual({
      whileRunning: { status: "uploading", kept: [setup.upload.id] },
      after: [],
    });
  });

  it("never lists this page's failed file, and lists nothing once its retry() ends done", async () => {
    const broken = failing("PUT part 2");
    const setup = persistFixture({ fault: broken.fault, options: { concurrency: 1 } });
    const { useUpload, useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => ({ hook: useUpload("files"), resumable: useResumable("files") }));
    await act(() => result.current.hook.upload(threeParts()));
    await setup.drained();
    const whileFailed = {
      status: result.current.hook.files[0]?.status,
      listed: ids((await act(() => result.current.resumable.refresh())).data),
      kept: (await setup.client.resumable()).data?.length,
    };
    broken.failing.on = false;
    await act(() => result.current.hook.files[0]?.retry());
    await setup.drained();

    expect({
      whileFailed,
      after: result.current.resumable.uploads,
      kept: (await setup.client.resumable()).data,
    }).toEqual({
      whileFailed: { status: "failed", listed: [], kept: 1 },
      after: [],
      kept: [],
    });
  });

  it("lists nothing once this page cancels its running upload, whose record the client deletes", async () => {
    const third = gate(partThree);
    const setup = persistFixture({ fault: third.fault, options: { concurrency: 1 } });
    const { useUpload, useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => ({ hook: useUpload("files"), resumable: useResumable("files") }));
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = result.current.hook.upload(threeParts());
    });
    await act(() => third.reached);
    await setup.drained();
    const keptWhileRunning = (await setup.client.resumable()).data?.length;
    act(() => result.current.hook.abort());
    await act(() => done);
    await setup.drained();

    expect({ keptWhileRunning, listed: result.current.resumable.uploads }).toEqual({ keptWhileRunning: 1, listed: [] });
  });

  it("lists an earlier upload again once the same file, uploaded anew, ends done after a retry()", async () => {
    // The new upload's part 2 fails: the page before the reload sent part 2 once already.
    const broken = failing("PUT part 2", 2);
    const setup = await reloaded(gate(partThree), broken.fault);
    const { useUpload, useResumable } = createUploadHooks({ client: setup.client });
    const { result } = renderHook(() => ({ hook: useUpload("files"), resumable: useResumable("files") }));
    await waitFor(() => expect(ids(result.current.resumable.uploads)).toEqual([setup.upload.id]), fast);
    // Uploaded anew, not resumed: a new upload of the same file, which the list cannot tell from the earlier one's.
    await act(() => result.current.hook.upload(fourParts()));
    await setup.drained();
    const whileFailed = ids(result.current.resumable.uploads);
    broken.failing.on = false;
    await act(() => result.current.hook.files[0]?.retry());
    await setup.drained();
    await waitFor(() => expect(ids(result.current.resumable.uploads)).toEqual([setup.upload.id]), fast);

    expect({ whileFailed, status: result.current.hook.files[0]?.status }).toEqual({ whileFailed: [], status: "done" });
  });
});
