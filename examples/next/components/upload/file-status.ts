// What the home page says about one file: the Attachment state it shows and the line under its name.
import type { RouteResult } from "cloudrop/client";
import type { UploadItem } from "cloudrop/react";
import type { cloudrop } from "@/lib/cloudrop";

/** One entry of useUpload("files").files: the route's onComplete returns `{ key }`. */
export type FileItem = UploadItem<RouteResult<typeof cloudrop, "files">>;

/** The states of shadcn's Attachment, the ones the owner's apps already style. */
export type AttachmentState = "idle" | "uploading" | "processing" | "error" | "done";

/** The client's seven statuses on the Attachment's five: a file that moves no bytes and has not failed is idle. */
const STATES: Record<FileItem["status"], AttachmentState> = {
  queued: "idle",
  paused: "idle",
  aborted: "idle",
  uploading: "uploading",
  completing: "processing",
  failed: "error",
  done: "done",
};

export const attachmentState = (status: FileItem["status"]): AttachmentState => STATES[status];

const UNITS = ["B", "KiB", "MiB", "GiB"];

/** 14 B, 5.0 KiB, 20.0 MiB: the binary units the client's part sizes use. */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}

export const percent = (progress: number): number => Math.floor(progress * 100);

/** Speed and time left while bytes move; empty when the client has no measure yet. */
export function pace(speed: number, eta: number | null): string {
  if (speed === 0) return "";
  return eta === null ? `, ${formatBytes(speed)}/s` : `, ${formatBytes(speed)}/s, ${Math.ceil(eta)} s left`;
}

/** The line under the file's name: what a person needs to know about it now. */
export function statusLine(file: FileItem): string {
  switch (file.status) {
    case "queued":
      return `${formatBytes(file.size)}, waiting for a connection`;
    case "uploading":
      return `${formatBytes(file.bytes)} of ${formatBytes(file.size)}${pace(file.speed, file.eta)}`;
    case "paused":
      return `Paused at ${percent(file.progress)}%`;
    case "completing":
      return "All bytes sent, finishing";
    case "done":
      return `${formatBytes(file.size)}, stored as ${file.result?.data.key}`;
    case "failed":
      return `${file.error?.code}: ${file.error?.message}`;
    case "aborted":
      return "Cancelled";
  }
}
