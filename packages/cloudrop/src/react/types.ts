// The public types of cloudrop/react (spec §6.1): what createUploadHooks returns and what its hooks take and give.

import type { ChangeEvent, DragEvent } from "react";
import type {
  ClientOptions,
  CloudropClient,
  CloudropError,
  FileOutcome,
  FileSnapshot,
  InferableCloudrop,
  JobSnapshot,
  Result,
  ResumableUpload,
  RouteMetadata,
  RouteName,
  RouteResult,
  UploadResult,
} from "../client.ts";

/** The client's options, to create the client on first use in the browser; or `{ client }` to share one. */
export type UploadHooksOptions<TCloudrop extends InferableCloudrop> =
  | ClientOptions
  | {
      // The added member is not generic, so a client of another server's routes is refused: the client's own generic
      // methods compare by their constraints, which would let any CloudropClient pass. A property, not a method, so
      // its parameter is compared strictly and a client of fewer routes is refused too.
      client: CloudropClient<TCloudrop> & { resumable: (route?: RouteName<TCloudrop>) => unknown };
    };

export interface UseUploadOptions<TMetadata, R = unknown> {
  /** Sent with every upload of the hook, validated by the route's schema; the latest render's value is used. */
  metadata?: TMetadata;
  /** The input's `multiple`; without it a drop uploads only its first file. Default false. */
  multiple?: boolean;
  /** The input's `accept`, such as "image/*": it filters the file picker only, the route's `accept` decides. */
  accept?: string;
  /**
   * A file of this route ended done, on its first try or after retry(), from any component on the route. Called for a
   * file that ended while this component was mounted, even when that end unmounts it; the latest render's function is
   * called.
   */
  onUploaded?: (file: Extract<FileOutcome<R>, { status: "done" }>) => void;
  /**
   * A file of this route ended failed (error.file is set), or a start was refused without a file row (error.file is
   * undefined). Never called for a cancel. Called as onUploaded is.
   */
  onError?: (error: CloudropError) => void;
}

/** The options argument is required when the route's metadata is. */
export type UseUploadArguments<TMetadata, R = unknown> = undefined extends TMetadata
  ? [options?: UseUploadOptions<TMetadata, R>]
  : [options: UseUploadOptions<TMetadata, R> & { metadata: TMetadata }];

/** One file of useUpload's `files`: the client's snapshot of it, with that file's controls (FileHandle). */
export interface UploadItem<R> extends FileSnapshot<R> {
  pause(): void;
  resume(): void;
  abort(): void;
  retry(): Promise<FileOutcome<R>>;
}

/** Spread onto an `<input>`: picking files uploads them. */
export interface InputProps {
  type: "file";
  multiple: boolean;
  accept: string | undefined;
  /** Uploads the picked files and clears the input, so that picking the same file again uploads it again. */
  onChange(event: ChangeEvent<HTMLInputElement>): void;
}

/** Spread onto any element: dropping files on it uploads them. */
export interface DropProps {
  onDragEnter(event: DragEvent<HTMLElement>): void;
  onDragOver(event: DragEvent<HTMLElement>): void;
  onDragLeave(event: DragEvent<HTMLElement>): void;
  onDrop(event: DragEvent<HTMLElement>): void;
}

export interface UseUploadResult<R, TName extends string, TMetadata> {
  /**
   * Every file of the uploads started on this route through any hook of the factory, in start order, kept across
   * unmounts. A file's object changes only when that file does.
   */
  files: readonly UploadItem<R>[];
  /** As JobSnapshot's totals, across the uploads in `files`: failed and aborted files are left out of the bytes. */
  totals: JobSnapshot<R>["totals"];
  /** True while a file is queued, uploading or completing; a paused file is not uploading. */
  isUploading: boolean;
  /** True while files are dragged over the element that has getDropProps(). */
  isDragOver: boolean;
  /**
   * The route's last start refused without a file row, such as CLIENT_CLOSED after close(); cleared by the route's next
   * start and by clear().
   */
  startError: CloudropError | null;
  /**
   * Starts one upload of the files and resolves with its result once every file has first settled. A FileList, an
   * array or one File; null or an empty list resolves null and starts nothing. The call's metadata replaces the hook's.
   */
  upload(files: File | ArrayLike<File> | null, options?: { metadata?: TMetadata }): Promise<UploadResult<R> | null>;
  getInputProps(): InputProps;
  getDropProps(): DropProps;
  /** Pauses every queued or uploading file in `files`. */
  pause(): void;
  /** Un-pauses every paused file in `files`. */
  resume(): void;
  /** Continues an upload useResumable listed, with the file the user picked again, as one more upload in `files`. */
  resumeUpload(upload: ResumableUpload<TName>, file: File): Promise<UploadResult<R>>;
  /** Cancels every file in `files` that has not ended done. */
  abort(): void;
  /** Sends every failed file in `files` again; resolves once they have settled. */
  retry(): Promise<void>;
  /**
   * Removes from `files`, for every component on the route, the uploads whose every file ended done or aborted. One
   * with a failed file stays: retry() can still send it.
   */
  clear(): void;
}

/** One route's records as a union per route, so that `record.route === "files"` narrows the record. */
type ResumableOf<TName extends string> = TName extends string ? ResumableUpload<TName> : never;

export interface UseResumableResult<TName extends string> {
  /**
   * The client's resumable() list, newest first; `[]` on the server, before the first read, when it failed, and after
   * `route` changes until that route's read answers.
   */
  uploads: readonly ResumableOf<TName>[];
  /**
   * The ids of the listed uploads this hook's discard() is dropping, from the call until the list is read again: a
   * second discard() of one of them would answer UPLOAD_IN_USE, so a page disables its button meanwhile.
   */
  discardingIds: ReadonlySet<string>;
  /** Reads the list again; resolves with the client's answer, whose error says why the list is empty. */
  refresh(): Promise<Result<ResumableOf<TName>[]>>;
  /**
   * The client's discard(): drops one listed upload without its file, then reads the list again. `aborted` is true once
   * the server accepted the /abort, which keeps a file whose /complete finished; false when the token could no longer
   * abort anything (the bucket's lifecycle rule cleans up).
   */
  discard(upload: ResumableOf<TName>): Promise<Result<{ aborted: boolean }>>;
  /**
   * The client's forget(): deletes the unfinished uploads of the client's namespace, of every route, not only this
   * hook's, then reads the list again.
   */
  forget(): Promise<Result<{ forgotten: number }>>;
}

export interface UploadHooks<TCloudrop extends InferableCloudrop> {
  /**
   * Uploads to `route`, with the files, progress and controls a page renders. Every component on one route shares its
   * list, and unmounting cancels nothing: a component that mounts again shows its running and failed files.
   */
  useUpload<TName extends RouteName<TCloudrop>>(
    route: TName,
    ...options: UseUploadArguments<RouteMetadata<TCloudrop, TName>, RouteResult<TCloudrop, TName>>
  ): UseUploadResult<RouteResult<TCloudrop, TName>, TName, RouteMetadata<TCloudrop, TName>>;
  /**
   * The unfinished uploads this browser keeps, of `route` or of every route, without the ones this page holds; read
   * after mount and whenever an upload of these hooks may have changed them.
   */
  useResumable<TName extends RouteName<TCloudrop> = RouteName<TCloudrop>>(route?: TName): UseResumableResult<TName>;
  /**
   * The client's close(), for every route the hooks upload to: afterwards every upload resolves CLIENT_CLOSED. Without
   * options, as when the user changed in another tab, multipart uploads keep their records for that user's next
   * client; with `{ abort: true }`, at sign-out, every file is cancelled and the server told. Resolves once every file
   * stopped and each /abort was answered. Not a hook: call it from an event handler or an effect.
   */
  close(options?: { abort: true }): Promise<void>;
}
