import { IconFile, IconPhoto, IconRefresh, IconX } from "@tabler/icons-react";
import type { FileStatus } from "cloudrop/client";
import type { UploadItem } from "cloudrop/react";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/format";

type AttachmentState = "idle" | "uploading" | "processing" | "error" | "done";

/**
 * How a cloudrop file maps onto the states of shadcn's Attachment: waiting and paused
 * files are idle, the bytes going out are uploading, `/complete` (the server verifies the object and runs onComplete)
 * is processing, and a cancelled file shows idle with its own line.
 */
const ATTACHMENT_STATE: Record<FileStatus, AttachmentState> = {
  queued: "idle",
  paused: "idle",
  uploading: "uploading",
  completing: "processing",
  done: "done",
  failed: "error",
  aborted: "idle",
};

/** The row's second line: progress, the error's message, or what the file is waiting for. */
function statusLine(file: UploadItem<unknown>): string {
  switch (file.status) {
    case "uploading":
      return `${Math.floor(file.progress * 100)}% of ${formatBytes(file.size)}`;
    case "failed":
      return file.error ? `${file.error.code}: ${file.error.message}` : "Failed";
    case "done":
      return `Uploaded, ${formatBytes(file.size)}`;
    case "completing":
      return "Finishing";
    case "paused":
      return "Paused";
    case "aborted":
      return "Cancelled";
    case "queued":
      return "Waiting";
  }
}

/** One upload from `useUpload`: name, state, progress, and cancel or retry. */
export function UploadRow({ file }: { file: UploadItem<unknown> }) {
  const running = file.status === "queued" || file.status === "uploading" || file.status === "paused";
  return (
    <Attachment state={ATTACHMENT_STATE[file.status]} className="w-full" role="group" aria-label={file.name}>
      <AttachmentMedia>{file.type.startsWith("image/") ? <IconPhoto /> : <IconFile />}</AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>{file.name}</AttachmentTitle>
        <AttachmentDescription role="status">{statusLine(file)}</AttachmentDescription>
        {file.status === "uploading" && <Progress value={file.progress * 100} className="mt-1.5" />}
      </AttachmentContent>
      <AttachmentActions>
        {running && (
          <AttachmentAction aria-label={`Cancel ${file.name}`} onClick={file.abort}>
            <IconX />
          </AttachmentAction>
        )}
        {file.status === "failed" && (
          <AttachmentAction aria-label={`Retry ${file.name}`} onClick={() => void file.retry()}>
            <IconRefresh />
          </AttachmentAction>
        )}
      </AttachmentActions>
    </Attachment>
  );
}
