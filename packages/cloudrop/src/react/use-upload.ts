// useUpload (spec §6.1, M4-B2, M4-B4): the jobs one component starts, rendered through useSyncExternalStore. No upload
// starts in an effect or during render, so StrictMode's second render and second effect start nothing.

import { useInsertionEffect, useState, useSyncExternalStore } from "react";
import type { CloudropClient, ResumableUpload, UploadJob, UploadResult } from "../client.ts";
import { createDropHandlers } from "./drop.ts";
import type { InputProps, UseUploadOptions, UseUploadResult } from "./types.ts";
import { createUploadStore, EMPTY_VIEW } from "./upload-store.ts";

/** What createUploadHooks shares with its hooks. */
export interface HookSource {
  /** The client, created on the first call: in a handler or an effect, so never during a server render. */
  client(): CloudropClient;
  /** Tells useResumable when the job settles, since a settled job may have added or removed a record. */
  started(job: UploadJob<unknown>): void;
  /** Calls `listener` whenever a job started through the hooks settles; returns the unsubscribe. */
  onSettled(listener: () => void): () => void;
}

interface Latest {
  route: string;
  options: UseUploadOptions<unknown>;
}

type Hook = UseUploadResult<unknown, string, unknown>;

/** Everything of a hook that keeps its identity across renders: React keeps one per component instance. */
function createController(source: HookSource, initial: Latest, setDragOver: (isOver: boolean) => void) {
  const store = createUploadStore<unknown>();
  // Event handlers read the committed render's route and options, so the functions below never change.
  const controller = { latest: initial, store };

  function start(job: UploadJob<unknown>): Promise<UploadResult<unknown>> {
    store.add(job);
    source.started(job);
    return job.done;
  }
  const upload: Hook["upload"] = (files, call = {}) => {
    const list = files instanceof File ? [files] : Array.from(files ?? []);
    if (list.length === 0) return Promise.resolve(null);
    const { route, options } = controller.latest;
    const metadata = "metadata" in call ? call.metadata : options.metadata;
    return start(source.client().start(route, list, { metadata }));
  };
  function resume(): void;
  function resume(upload: ResumableUpload, file: File): Promise<UploadResult<unknown>>;
  function resume(...record: [] | [ResumableUpload, File]): Promise<UploadResult<unknown>> | undefined {
    if (record.length === 2) return start(source.client().resume(...record));
    for (const job of store.jobs()) job.resume();
  }
  const onChange: InputProps["onChange"] = (event) => {
    const input = event.currentTarget;
    const picked = Array.from(input.files ?? []);
    // Cleared so that picking the same file again uploads it: Chromium fires `cancel`, not `change`, for an unchanged
    // selection.
    input.value = "";
    void upload(picked);
  };
  const dropProps = createDropHandlers(setDragOver, (files) => {
    void upload(controller.latest.options.multiple ? files : files.slice(0, 1));
  });
  const actions: Pick<Hook, "upload" | "pause" | "resume" | "abort" | "retry" | "clear"> = {
    upload,
    pause: () => {
      for (const job of store.jobs()) job.pause();
    },
    resume,
    abort: () => {
      for (const job of store.jobs()) job.abort();
    },
    retry: async () => {
      await Promise.all(store.jobs().map((job) => job.retry()));
    },
    clear: store.clear,
  };
  return Object.assign(controller, { actions, onChange, dropProps });
}

const serverView = () => EMPTY_VIEW;

export function useUploadWith(source: HookSource, route: string, options: UseUploadOptions<unknown> = {}): Hook {
  const [isDragOver, setDragOver] = useState(false);
  const [controller] = useState(() => createController(source, { route, options }, setDragOver));
  useInsertionEffect(() => {
    controller.latest = { route, options };
  });
  const view = useSyncExternalStore(controller.store.subscribe, controller.store.getSnapshot, serverView);
  const { multiple = false, accept } = options;
  return {
    ...view,
    ...controller.actions,
    isDragOver,
    getInputProps: () => ({ type: "file", multiple, accept, onChange: controller.onChange }),
    getDropProps: () => controller.dropProps,
  };
}
