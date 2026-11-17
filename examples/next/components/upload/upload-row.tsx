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
import { memo, useRef } from "react";
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
import { ATTACHMENT_STATE, type AttachmentState, type FileItem, percent, statusLine } from "./file-status";

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
  // Retry and Cancel remove their own button: focus moves to the row first, so a keyboard user stays in the list and a
  // screen reader reads the row's new state.
  const row = useRef<HTMLLIElement>(null);
  const thenFocusRow = (action: () => unknown) => () => {
    row.current?.focus();
    void action();
  };
  const state = ATTACHMENT_STATE[file.status];
  const Icon = ICONS[state];
  const moving = file.status === "queued" || file.status === "uploading";
  const ended = file.status === "done" || file.status === "aborted";
  return (
    <li ref={row} tabIndex={-1} className="rounded-3xl outline-offset-2 focus-visible:outline-2">
      <Attachment state={state} className="w-full">
        <AttachmentMedia>
          <Icon
            aria-hidden
            className={state === "uploading" || state === "processing" ? "motion-safe:animate-spin" : undefined}
          />
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
          {/* One button for both, so React keeps the element and its keyboard focus when the file pauses or resumes. */}
          {(moving || file.status === "paused") && (
            <AttachmentAction
              aria-label={`${moving ? "Pause" : "Resume"} ${file.name}`}
              onClick={moving ? file.pause : file.resume}
            >
              {moving ? <IconPlayerPause /> : <IconPlayerPlay />}
            </AttachmentAction>
          )}
          {file.status === "failed" && (
            <AttachmentAction aria-label={`Retry ${file.name}`} onClick={thenFocusRow(file.retry)}>
              <IconRefresh />
            </AttachmentAction>
          )}
          {!ended && (
            <AttachmentAction aria-label={`Cancel ${file.name}`} onClick={thenFocusRow(file.abort)}>
              <IconX />
            </AttachmentAction>
          )}
        </AttachmentActions>
      </Attachment>
    </li>
  );
});
