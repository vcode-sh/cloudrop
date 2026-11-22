import { IconPlayerPlay, IconTrash } from "@tabler/icons-react";
import type { ResumableUpload } from "cloudrop/client";
import { useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/lib/format";
import { useUploads } from "@/lib/upload";
import { ATTACHMENTS_INPUT_ID } from "./drop-zone";

type Unfinished = ResumableUpload<"attachments">;

const discardId = (upload: Unfinished): string => `discard-${upload.id}`;

/**
 * Multipart uploads this browser started and did not finish, after a reload or a crash. A browser never gives a page a
 * file back, so the user picks the same file again and only the missing parts are sent. Discard tells the API to abort
 * the upload, without the file, and deletes the browser's record of it; with the store, its row ends as aborted and
 * the bytes it reserved count against the quota no more.
 */
export function UnfinishedUploads() {
  const { useResumable, useUpload } = useUploads();
  // `discardingIds`: the ids being discarded, whose second press would find the first one's lock (UPLOAD_IN_USE).
  const { uploads, discardingIds, discard } = useResumable("attachments");
  const { resumeUpload } = useUpload("attachments");
  // The message of the last discard that failed, such as an unreachable API: its upload stays listed for a retry.
  const [problem, setProblem] = useState<string | null>(null);
  if (uploads.length === 0) return null;

  const discardEach = async (chosen: readonly Unfinished[]) => {
    // A discarded row unmounts, and the whole panel with the last one: focus first moves to what stays, the next row's
    // Discard or else the drop zone's input, so a keyboard user is not sent back to the top of the page.
    const at = uploads.indexOf(chosen[0] as Unfinished);
    const stays = chosen.length === 1 ? (uploads[at + 1] ?? uploads[at - 1]) : undefined;
    document.getElementById(stays ? discardId(stays) : ATTACHMENTS_INPUT_ID)?.focus();
    setProblem(null);
    const answers = await Promise.all(chosen.map((upload) => discard(upload)));
    setProblem(answers.find((answer) => answer.error)?.error?.message ?? null);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Unfinished uploads</CardTitle>
        <CardDescription>Pick the same file again to send the rest of it, or discard it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {problem && <p role="alert">{problem}</p>}
        <ul aria-label="Unfinished uploads" className="flex flex-col gap-2">
          {uploads.map((upload) => (
            <li key={upload.id} className="flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {upload.name}, {formatBytes(upload.size)}
              </span>
              {/* The ring follows the hidden input's focus: the label itself never takes it. */}
              <label
                className={buttonVariants({
                  size: "sm",
                  variant: "outline",
                  className: "has-focus-visible:border-ring has-focus-visible:ring-3 has-focus-visible:ring-ring/30",
                })}
              >
                <IconPlayerPlay />
                Resume
                <input
                  type="file"
                  aria-label={`Pick ${upload.name} again`}
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    // Cleared, so that picking the same file after a refused resume fires `change` again.
                    event.currentTarget.value = "";
                    if (file) void resumeUpload(upload, file);
                  }}
                />
              </label>
              <Button
                id={discardId(upload)}
                size="icon-sm"
                variant="ghost"
                aria-label={`Discard ${upload.name}`}
                disabled={discardingIds.has(upload.id)}
                onClick={() => void discardEach([upload])}
              >
                <IconTrash />
              </Button>
            </li>
          ))}
        </ul>
        <Button
          variant="ghost"
          className="self-start"
          disabled={discardingIds.size > 0}
          onClick={() => void discardEach(uploads)}
        >
          Discard all
        </Button>
      </CardContent>
    </Card>
  );
}
