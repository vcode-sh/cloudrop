"use client";

import { IconPlayerPause } from "@tabler/icons-react";
import type { ResumableUpload } from "cloudrop/client";
import type { ChangeEvent } from "react";
import {
  Attachment,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentMedia,
  AttachmentTitle,
} from "@/components/ui/attachment";
import { Button, buttonVariants } from "@/components/ui/button";
import { client, useResumable, useUpload } from "@/lib/upload";
import { formatBytes } from "./file-status";

const until = (expiresAt: string): string =>
  new Date(expiresAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

/**
 * The multipart uploads this browser kept when the page closed or reloaded mid-upload. A browser never hands a file
 * back after a reload, so the person picks it again; the resumed upload then joins the list below as a new file.
 */
export function UnfinishedUploads() {
  const { uploads, refresh } = useResumable("files");
  const { resume } = useUpload("files");
  if (uploads.length === 0) return null;

  const pickAgain = (upload: ResumableUpload<"files">) => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    // Cleared, so that picking the same file after a refused resume fires `change` again.
    event.currentTarget.value = "";
    // Another file than the one the upload started with is refused before any request, and shows as a failed file.
    if (file) void resume(upload, file);
  };
  // Deletes this browser's records, not the uploads: the bucket's lifecycle rule removes their parts.
  const discardAll = async () => {
    await client.forget();
    await refresh();
  };

  return (
    <section aria-labelledby="unfinished-heading" className="space-y-3">
      <h2 id="unfinished-heading" className="font-heading font-semibold text-lg">
        Unfinished uploads
      </h2>
      <p className="text-muted-foreground text-sm">
        These stopped before they finished. Pick the same file again to continue: only the parts the bucket lacks are
        sent.
      </p>
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
              <AttachmentActions>
                <label className={buttonVariants({ variant: "outline", size: "sm" })}>
                  Pick again
                  <input
                    type="file"
                    aria-label={`Pick ${upload.name} again to resume`}
                    className="sr-only"
                    onChange={pickAgain(upload)}
                  />
                </label>
              </AttachmentActions>
            </Attachment>
          </li>
        ))}
      </ul>
      <Button variant="ghost" size="sm" onClick={() => void discardAll()}>
        Discard all
      </Button>
    </section>
  );
}
