// What the home page says about one file: the Attachment state it shows and the line under its name.
import type { RouteResult } from "cloudrop/client";
import type { UploadItem } from "cloudrop/react";
import type { ComponentProps } from "react";
import type { Attachment } from "@/components/ui/attachment";
import type { cloudrop } from "@/lib/cloudrop";

/** One entry of useUpload("files").files: the route's onComplete returns `{ key }`. */
export type FileItem = UploadItem<RouteResult<typeof cloudrop, "files">>;

/** The states of shadcn's Attachment, read from the vendored component so that a CLI update carries them. */
export type AttachmentState = NonNullable<ComponentProps<typeof Attachment>["state"]>;

/** The client's seven statuses on the Attachment's five: a file that moves no bytes and has not failed is idle. */
export const ATTACHMENT_STATE: Record<FileItem["status"], AttachmentState> = {
  queued: "idle",
  paused: "idle",
  aborted: "idle",
  uploading: "uploading",
  completing: "processing",
  failed: "error",
  done: "done",
};

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

/** Seconds up to a minute and a half, then whole minutes: "2000 s left" means nothing at a glance. */
const timeLeft = (eta: number): string => (eta <= 90 ? `${Math.ceil(eta)} s left` : `${Math.ceil(eta / 60)} min left`);

/** Speed and time left while bytes move; empty when the client has no measure yet. */
export function pace(speed: number, eta: number | null): string {
  if (speed === 0) return "";
  return eta === null ? `, ${formatBytes(speed)}/s` : `, ${formatBytes(speed)}/s, ${timeLeft(eta)}`;
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
