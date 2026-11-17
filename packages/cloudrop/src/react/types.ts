// The public types of cloudrop/react (spec §6.1): what createUploadHooks returns and what its hooks take and give.

import type { ChangeEvent, DragEvent } from "react";
import type {
  ClientOptions,
  CloudropClient,
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

export interface UseUploadOptions<TMetadata> {
  /** Sent with every upload of the hook, validated by the route's schema; the latest render's value is used. */
  metadata?: TMetadata;
  /** The input's `multiple`; without it a drop uploads only its first file. Default false. */
  multiple?: boolean;
  /** The input's `accept`, such as "image/*": it filters the file picker only, the route's `accept` decides. */
  accept?: string;
}

/** The options argument is required when the route's metadata is. */
export type UseUploadArguments<TMetadata> = undefined extends TMetadata
  ? [options?: UseUploadOptions<TMetadata>]
  : [options: UseUploadOptions<TMetadata> & { metadata: TMetadata }];

/** One file of useUpload's `files`: the client's snapshot of it, with that file's controls (FileHandle). */
export interface UploadFile<R> extends FileSnapshot<R> {
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
  /** Every file of the uploads this hook started, in start order. A file's object changes only when that file does. */
  files: readonly UploadFile<R>[];
  /** As JobSnapshot's totals, across the hook's uploads: failed and aborted files are left out of the bytes. */
  totals: JobSnapshot<R>["totals"];
  /** True while a file is queued, uploading or completing; a paused file is not uploading. */
  isUploading: boolean;
  /** True while files are dragged over the element that has getDropProps(). */
  isDragOver: boolean;
  /**
   * Starts one upload of the files and resolves with its result once every file has first settled. A FileList, an
   * array or one File; null or an empty list resolves null and starts nothing. The call's metadata replaces the hook's.
   */
  upload(files: File | ArrayLike<File> | null, options?: { metadata?: TMetadata }): Promise<UploadResult<R> | null>;
  getInputProps(): InputProps;
  getDropProps(): DropProps;
  /** Pauses every queued or uploading file of the hook. */
  pause(): void;
  /** Resumes every paused file of the hook. */
  resume(): void;
  /** Continues an upload useResumable listed, with the file the user picked again, as one more upload of the hook. */
  resume(upload: ResumableUpload<TName>, file: File): Promise<UploadResult<R>>;
  /** Cancels every file of the hook that has not ended done. */
  abort(): void;
  /** Sends every failed file of the hook again; resolves once they have settled. */
  retry(): Promise<void>;
  /** Removes from `files` the uploads whose every file has ended (done, failed or aborted). */
  clear(): void;
}

/** One route's records as a union per route, so that `record.route === "files"` narrows the record. */
type ResumableOf<TName extends string> = TName extends string ? ResumableUpload<TName> : never;

export interface UseResumableResult<TName extends string> {
  /** The client's resumable() list, newest first; `[]` on the server, before the first read and when it failed. */
  uploads: readonly ResumableOf<TName>[];
  /** Reads the list again; resolves with the client's answer, whose error says why the list is empty. */
  refresh(): Promise<Result<ResumableOf<TName>[]>>;
}

export interface UploadHooks<TCloudrop extends InferableCloudrop> {
  /** Uploads to `route`, with the files, progress and controls a page renders. Stays with the client on unmount. */
  useUpload<TName extends RouteName<TCloudrop>>(
    route: TName,
    ...options: UseUploadArguments<RouteMetadata<TCloudrop, TName>>
  ): UseUploadResult<RouteResult<TCloudrop, TName>, TName, RouteMetadata<TCloudrop, TName>>;
  /** The unfinished uploads this browser keeps, of `route` or of every route, read after mount and after each upload. */
  useResumable<TName extends RouteName<TCloudrop> = RouteName<TCloudrop>>(route?: TName): UseResumableResult<TName>;
}
