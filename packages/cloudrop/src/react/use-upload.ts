// useUpload (spec §6.1, M4-B2, M4-B4): the jobs a factory's hooks started on one route, rendered through
// useSyncExternalStore. No upload starts in an effect or during render, so StrictMode's second render and second effect
// start nothing. The hook follows the factory of its latest render, as it follows the route: hooks taken from a context
// that changed upload through the new factory's client and show its list (M11-R4).

import { useCallback, useInsertionEffect, useState, useSyncExternalStore } from "react";
import { isList } from "../client/arguments.ts";
import type { CloudropClient, Result, UploadJob, UploadResult } from "../client.ts";
import { createDropHandlers } from "./drop.ts";
import type { JobTracker } from "./job-tracker.ts";
import type { InputProps, UseUploadOptions, UseUploadResult } from "./types.ts";
import { EMPTY_VIEW, type UploadStore } from "./upload-store.ts";

/** What createUploadHooks shares with its hooks: the client and the jobs they started. */
export interface HookSource extends JobTracker {
  /** The jobs started on `route` through any hook of the factory: they outlive the component that started them. */
  storeOf(route: string): UploadStore<unknown>;
  /**
   * The client, created on the first call: in a handler or an effect, so never during a server render. A wrong option
   * gives its INVALID_CONFIG error, which upload(), resumeUpload() and refresh() resolve with.
   */
  client(): Result<CloudropClient>;
}

interface Latest {
  source: HookSource;
  route: string;
  options: UseUploadOptions<unknown>;
}

type Hook = UseUploadResult<unknown, string, unknown>;

/** Everything of a hook that keeps its identity across renders: React keeps one per component instance. */
function createController(initial: Latest, setDragOver: (isOver: boolean) => void) {
  // Event handlers read the committed render's factory, route and options, so the functions below never change.
  const controller = { latest: initial };
  const store = () => controller.latest.source.storeOf(controller.latest.route);
  const jobs = () => store().jobs();

  function start(begin: (client: CloudropClient) => UploadJob<unknown>): Promise<UploadResult<unknown>> {
    const { source } = controller.latest;
    const client = source.client();
    if (client.error) return Promise.resolve({ data: null, error: client.error });
    const job = begin(client.data);
    // A job refused before it started, by a closed client or for its arguments, has no file to list, retry or follow:
    // its `done` carries the refusal (M11-R6).
    if (job.files.length > 0) {
      store().add(job);
      source.track(job);
    }
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
  /** Files from a pick or a drop: no caller sees the result, so a wrong client option is thrown in a task (M3-U8). */
  const take = (files: File[]) => {
    const { error } = controller.latest.source.client();
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
  const actions: Pick<
    Hook,
    "upload" | "pause" | "resume" | "resumeUpload" | "abort" | "retry" | "clear" | "getDropProps"
  > = {
    upload,
    pause: () => {
      for (const job of jobs()) job.pause();
    },
    resume: () => {
      for (const job of jobs()) job.resume();
    },
    resumeUpload: (record, file) => start((client) => client.resume(record, file)),
    abort: () => {
      for (const job of jobs()) job.abort();
    },
    retry: async () => {
      await Promise.all(jobs().map((job) => job.retry()));
    },
    clear: () => store().clear(),
    getDropProps: () => dropProps,
  };
  return Object.assign(controller, { actions, onChange });
}

const serverView = () => EMPTY_VIEW;

export function useUploadWith(source: HookSource, route: string, options: UseUploadOptions<unknown> = {}): Hook {
  const [isDragOver, setDragOver] = useState(false);
  const [controller] = useState(() => createController({ source, route, options }, setDragOver));
  useInsertionEffect(() => {
    controller.latest = { source, route, options };
  });
  const store = source.storeOf(route);
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot, serverView);
  const { multiple = false, accept } = options;
  // Built from this render's options, so a changed `accept` reaches the input in the same render.
  const getInputProps = useCallback(
    (): InputProps => ({ type: "file", multiple, accept, onChange: controller.onChange }),
    [multiple, accept, controller],
  );
  return { ...view, ...controller.actions, isDragOver, getInputProps };
}
