import { IconUpload } from "@tabler/icons-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useUploads } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { announcement, UploadRow } from "./upload-row";
import { useRefreshFilesWhenDone } from "./use-refresh-files";

/** The drop zone's input, where focus goes when the unfinished-uploads panel it was in disappears. */
export const ATTACHMENTS_INPUT_ID = "attachments-input";

/** The attachments route: drop or choose several files; each shows its progress, with cancel and retry. */
export function DropZone() {
  const { useUpload } = useUploads();
  const { files, totals, isUploading, isDragOver, getDropProps, getInputProps, clear } = useUpload("attachments", {
    multiple: true,
  });
  useRefreshFilesWhenDone(totals.done);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Attachments</CardTitle>
        <CardDescription>Up to 10 files at once, 100 MB each. Files over 8 MB go in parts.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div
          {...getDropProps()}
          className={cn(
            "flex flex-col items-center gap-2 rounded-3xl border border-dashed p-8 text-center text-sm text-muted-foreground",
            isDragOver && "border-primary bg-muted",
          )}
        >
          <IconUpload />
          <p>{isDragOver ? "Drop to upload" : "Drop files here, or"}</p>
          <label className={buttonVariants({ variant: "outline" })}>
            Choose files
            <input {...getInputProps()} id={ATTACHMENTS_INPUT_ID} aria-label="Choose attachments" className="sr-only" />
          </label>
        </div>
        {/* Rendered before the first file, so that a screen reader is already listening when it changes. */}
        <p role="status" className="sr-only">
          {announcement(totals, isUploading)}
        </p>
        {files.length > 0 && (
          <ul aria-label="Uploads" className="flex flex-col gap-2">
            {files.map((file) => (
              <li key={file.id}>
                <UploadRow file={file} />
              </li>
            ))}
          </ul>
        )}
        {totals.done + totals.aborted > 0 && (
          <Button variant="ghost" className="self-start" onClick={clear}>
            Clear finished
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
