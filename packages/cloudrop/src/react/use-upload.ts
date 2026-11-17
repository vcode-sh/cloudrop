// useUpload (spec §6.1, M4-B2, M4-B4): the jobs one component starts, rendered through useSyncExternalStore. No upload
// starts in an effect or during render, so StrictMode's second render and second effect start nothing.

import { useInsertionEffect, useState, useSyncExternalStore } from "react";
import { isList } from "../client/arguments.ts";
import type { CloudropClient, Result, ResumableUpload, UploadJob, UploadResult } from "../client.ts";
import { createDropHandlers } from "./drop.ts";
import type { JobTracker } from "./job-tracker.ts";
import type { InputProps, UseUploadOptions, UseUploadResult } from "./types.ts";
import { createUploadStore, EMPTY_VIEW } from "./upload-store.ts";

/** What createUploadHooks shares with its hooks: the client and the jobs they started. */
export interface HookSource extends JobTracker {
  /**
   * The client, created on the first call: in a handler or an effect, so never during a server render. A wrong option
   * gives its INVALID_CONFIG error, which upload(), resume() and refresh() resolve with.
   */
  client(): Result<CloudropClient>;
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

  function start(begin: (client: CloudropClient) => UploadJob<unknown>): Promise<UploadResult<unknown>> {
    const client = source.client();
    if (client.error) return Promise.resolve({ data: null, error: client.error });
    const job = begin(client.data);
    store.add(job);
    source.track(job);
    return job.done;
  }
  const upload: Hook["upload"] = (files, call = {}) => {
    // Anything but null or an empty list goes to the client, which checks it is a File or a list of them (readFiles in
    // client/arguments.ts).
    if (files === null || (isList(files) && files.length === 0)) return Promise.resolve(null);
    const { route, options } = controller.latest;
    const metadata = "metadata" in call ? call.metadata : options.metadata;
    return start((client) => client.start(route, files, { metadata }));
  };
  function resume(): void;
  function resume(upload: ResumableUpload, file: File): Promise<UploadResult<unknown>>;
  function resume(...record: [] | [ResumableUpload, File]): Promise<UploadResult<unknown>> | undefined {
    if (record.length === 2) return start((client) => client.resume(...record));
    for (const job of store.jobs()) job.resume();
  }
  /** Files from a pick or a drop: no caller sees the result, so a wrong client option is thrown in a task (M3-U8). */
  const take = (files: File[]) => {
    const { error } = source.client();
    if (!error) return void upload(files);
    setTimeout(() => {
      throw error;
    });
  };
  const onChange: InputProps["onChange"] = (event) => {
    const input = event.currentTarget;
    const picked = Array.from(input.files ?? []);
    // Cleared so that picking the same file again uploads it: Chromium fires `cancel`, not `change`, for an unchanged
    // selection.
    input.value = "";
    take(picked);
  };
  const dropProps = createDropHandlers(setDragOver, (files) =>
    take(controller.latest.options.multiple ? files : files.slice(0, 1)),
  );
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
