"use client";

import { IconPlayerPause, IconTrash } from "@tabler/icons-react";
import type { ResumableUpload } from "cloudrop/client";
import { type ChangeEvent, useState } from "react";
import {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Button, buttonVariants } from "@/components/ui/button";
import { useResumable, useUpload } from "@/lib/upload";
import { FILES_INPUT_ID } from "./drop-zone";
import { formatBytes } from "./file-status";

const discardId = (upload: ResumableUpload<"files">): string => `discard-${upload.id}`;

const until = (expiresAt: string): string =>
  new Date(expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * The multipart uploads this browser kept when the page closed or reloaded mid-upload. A browser never hands a file
 * back after a reload, so the person picks it again; the resumed upload then joins the list below as a new file.
 * Discard tells the server to abort the upload, without the file, and deletes the browser's record of it.
 */
export function UnfinishedUploads() {
  const { uploads, discard } = useResumable("files");
  const { resume } = useUpload("files");
  // The message of the last discard that failed, such as an unreachable server: its upload stays listed for a retry.
  const [problem, setProblem] = useState<string | null>(null);
  // The ids being discarded: a second press would find the first one's lock and report UPLOAD_IN_USE.
  const [discarding, setDiscarding] = useState<ReadonlySet<string>>(new Set());
  if (uploads.length === 0) return null;

  const pickAgain = (upload: ResumableUpload<"files">) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // Cleared, so that picking the same file after a refused resume fires `change` again.
    event.currentTarget.value = "";
    // Another file than the one the upload started with is refused before any request, and shows as a failed file.
    if (file) void resume(upload, file);
  };
  const discardEach = async (chosen: readonly ResumableUpload<"files">[]) => {
    // A discarded row unmounts, and the whole panel with the last one: focus first moves to what stays, the next row's
    // Discard or else the drop zone, so a keyboard user is not sent back to the top of the page.
    const at = uploads.indexOf(chosen[0] as ResumableUpload<"files">);
    const stays = chosen.length === 1 ? (uploads[at + 1] ?? uploads[at - 1]) : undefined;
    document.getElementById(stays ? discardId(stays) : FILES_INPUT_ID)?.focus();
    const ids = chosen.map(({ id }) => id);
    setProblem(null);
    setDiscarding((now) => new Set([...now, ...ids]));
    const answers = await Promise.all(chosen.map((upload) => discard(upload)));
    setDiscarding((now) => new Set([...now].filter((id) => !ids.includes(id))));
    setProblem(answers.find((answer) => answer.error)?.error?.message ?? null);
  };

  return (
    <section aria-labelledby="unfinished-heading" className="space-y-3">
      <h2 id="unfinished-heading" className="font-heading font-semibold text-lg">
        Unfinished uploads
      </h2>
      <p className="text-muted-foreground text-sm">
        These stopped before they finished. Pick the same file again to continue: only the parts the bucket lacks are
        sent. Discard drops an upload without its file.
      </p>
      {problem && (
        <p role="alert" className="text-destructive text-sm">
          {problem}
        </p>
      )}
      <ul aria-labelledby="unfinished-heading" className="space-y-2">
        {uploads.map((upload) => (
          <li key={upload.id}>
            <Attachment state="idle" className="w-full">
              <AttachmentMedia>
                <IconPlayerPause aria-hidden />
              </AttachmentMedia>
              <AttachmentContent>
                <AttachmentTitle>{upload.name}</AttachmentTitle>
                <AttachmentDescription>
                  {formatBytes(upload.size)}, can be resumed until {until(upload.expiresAt)}
                </AttachmentDescription>
              </AttachmentContent>
              <AttachmentActions className="gap-1">
                {/* The ring follows the hidden input's focus: the label itself never takes it. */}
                <label
                  className={buttonVariants({
                    variant: "outline",
                    size: "sm",
                    className: "has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/30",
                  })}
                >
                  Pick again
                  <input
                    type="file"
                    aria-label={`Pick ${upload.name} again to resume`}
                    className="sr-only"
                    onChange={pickAgain(upload)}
                  />
                </label>
                <AttachmentAction
                  id={discardId(upload)}
                  aria-label={`Discard ${upload.name}`}
                  disabled={discarding.has(upload.id)}
                  onClick={() => void discardEach([upload])}
                >
                  <IconTrash />
                </AttachmentAction>
              </AttachmentActions>
            </Attachment>
          </li>
        ))}
      </ul>
      <Button variant="ghost" size="sm" disabled={discarding.size > 0} onClick={() => void discardEach(uploads)}>
        Discard all
      </Button>
    </section>
  );
}
