import { IconPlayerPlay } from "@tabler/icons-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatBytes } from "@/lib/format";
import { uploadClient, useResumable, useUpload } from "@/lib/upload";

/**
 * Multipart uploads this browser started and did not finish, after a reload or a crash. A browser never gives a page a
 * file back, so the user picks the same file again and only the missing parts are sent. Discarding uses the client's
 * forget(), which deletes this browser's records of them all; there is no call for one record. What they left in the
 * bucket goes when their tickets expire: the worker's sweep and the bucket's lifecycle rule remove it.
 */
export function UnfinishedUploads() {
  const { uploads, refresh } = useResumable("attachments");
  const { resume } = useUpload("attachments", { multiple: true });
  if (uploads.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Unfinished uploads</CardTitle>
        <CardDescription>Pick the same file again to send the rest of it.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ul aria-label="Unfinished uploads" className="flex flex-col gap-2">
          {uploads.map((upload) => (
            <li
              key={upload.id}
              className="flex items-center justify-between gap-3 rounded-2xl border px-3 py-2 text-sm"
            >
              <span className="min-w-0 truncate">
                {upload.name}, {formatBytes(upload.size)}
              </span>
              <label className={buttonVariants({ size: "sm", variant: "outline" })}>
                <IconPlayerPlay />
                Resume
                <input
                  type="file"
                  aria-label={`Pick ${upload.name} again`}
                  className="sr-only"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) void resume(upload, file);
                  }}
                />
              </label>
            </li>
          ))}
        </ul>
        <Button
          variant="ghost"
          className="self-start"
          onClick={async () => {
            await uploadClient.forget();
            await refresh();
          }}
        >
          Discard all
        </Button>
      </CardContent>
    </Card>
  );
}
