"use client";

import type { JobSnapshot } from "cloudrop/client";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useUpload } from "@/lib/upload";
import { formatBytes, pace, percent } from "./file-status";
import { UploadRow } from "./upload-row";

type Totals = JobSnapshot<unknown>["totals"];

/**
 * The visible totals line. Failed and cancelled files are left out of the bytes, as the hook counts them, so with
 * nothing else left the bytes are left out too: "0 B of 0 B" tells a person nothing.
 */
const totalsText = (totals: Totals, isUploading: boolean): string =>
  `${totals.done} of ${totals.count} uploaded` +
  (totals.size > 0 ? `, ${formatBytes(totals.bytes)} of ${formatBytes(totals.size)}` : "") +
  (isUploading ? pace(totals.speed, totals.eta) : "") +
  (totals.failed > 0 ? `, ${totals.failed} failed` : "");

/**
 * What a screen reader hears: the count and the progress in steps of 10 %, so a polite region speaks a few times per
 * upload rather than on every progress event.
 */
const announcement = (totals: Totals, isUploading: boolean): string =>
  totals.count === 0
    ? ""
    : `${totals.done} of ${totals.count} files uploaded` +
      (isUploading ? `, ${Math.floor(totals.progress * 10) * 10}% sent` : "") +
      (totals.failed > 0 ? `, ${totals.failed} failed` : "");

/** Every file of the route, from any component's useUpload("files"), with the controls that act on all of them. */
export function UploadList() {
  const { files, totals, isUploading, pause, resume, abort, retry, clear } = useUpload("files");
  // From the hooks' contracts: pause() acts on queued and uploading files, resume() on paused ones, and abort() on every
  // file not ended done or aborted, failed ones included. clear() removes only uploads whose every file ended done or
  // aborted: a failed file keeps its upload for retry(), so Clear finished waits until no file has failed.
  const pausable = files.some((file) => file.status === "queued" || file.status === "uploading");
  const hasPaused = files.some((file) => file.status === "paused");
  const cancellable = files.some((file) => file.status !== "done" && file.status !== "aborted");
  const clearable = totals.failed === 0 && totals.done + totals.aborted > 0;
  return (
    <>
      {/* Rendered before the first file, so that a screen reader is already listening when it changes. */}
      <p role="status" className="sr-only">
        {announcement(totals, isUploading)}
      </p>
      {files.length > 0 && (
        <section aria-labelledby="uploads-heading" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="uploads-heading" className="font-heading font-semibold text-lg">
              Uploads
            </h2>
            <div className="flex flex-wrap gap-1">
              <Button variant="ghost" size="sm" onClick={pause} disabled={!pausable}>
                Pause all
              </Button>
              <Button variant="ghost" size="sm" onClick={() => resume()} disabled={!hasPaused}>
                Resume all
              </Button>
              {totals.failed > 0 && (
                <Button variant="ghost" size="sm" onClick={() => void retry()}>
                  Retry failed
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={abort} disabled={!cancellable}>
                Cancel all
              </Button>
              <Button variant="ghost" size="sm" onClick={clear} disabled={!clearable}>
                Clear finished
              </Button>
            </div>
          </div>
          <Progress value={percent(totals.progress)} aria-label="All uploads" />
          <p className="text-muted-foreground text-sm">{totalsText(totals, isUploading)}</p>
          <ul aria-labelledby="uploads-heading" className="space-y-2">
            {files.map((file) => (
              <UploadRow key={file.id} file={file} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
