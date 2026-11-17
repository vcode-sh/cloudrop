"use client";

import {
  IconAlertTriangle,
  IconCheck,
  IconClock,
  IconLoader2,
  IconPlayerPause,
  IconPlayerPlay,
  IconRefresh,
  IconX,
} from "@tabler/icons-react";
import { memo } from "react";
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
import { type AttachmentState, attachmentState, type FileItem, percent, statusLine } from "./file-status";

const ICONS: Record<AttachmentState, typeof IconCheck> = {
  idle: IconClock,
  uploading: IconLoader2,
  processing: IconLoader2,
  error: IconAlertTriangle,
  done: IconCheck,
};

/**
 * One file as an Attachment, with the controls its status allows. memo: a file's object changes only when that file
 * does, so a row renders again only for its own progress.
 */
export const UploadRow = memo(function UploadRow({ file }: { file: FileItem }) {
  const state = attachmentState(file.status);
  const Icon = ICONS[state];
  const moving = file.status === "queued" || file.status === "uploading";
  const ended = file.status === "done" || file.status === "aborted";
  return (
    <li>
      <Attachment state={state} className="w-full">
        <AttachmentMedia>
          <Icon aria-hidden className={state === "uploading" || state === "processing" ? "animate-spin" : undefined} />
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentTitle>{file.name}</AttachmentTitle>
          {/* Not truncated: an error's message says what to do next, and a cut sentence says nothing. */}
          <AttachmentDescription className="whitespace-normal wrap-anywhere">{statusLine(file)}</AttachmentDescription>
          {(moving || file.status === "paused") && (
            <Progress value={percent(file.progress)} aria-label={`${file.name} progress`} className="mt-2" />
          )}
        </AttachmentContent>
        <AttachmentActions>
          {moving && (
            <AttachmentAction aria-label={`Pause ${file.name}`} onClick={file.pause}>
              <IconPlayerPause />
            </AttachmentAction>
          )}
          {file.status === "paused" && (
            <AttachmentAction aria-label={`Resume ${file.name}`} onClick={file.resume}>
              <IconPlayerPlay />
            </AttachmentAction>
          )}
          {file.status === "failed" && (
            <AttachmentAction aria-label={`Retry ${file.name}`} onClick={() => void file.retry()}>
              <IconRefresh />
            </AttachmentAction>
          )}
          {!ended && (
            <AttachmentAction aria-label={`Cancel ${file.name}`} onClick={file.abort}>
              <IconX />
            </AttachmentAction>
          )}
        </AttachmentActions>
      </Attachment>
    </li>
  );
});
