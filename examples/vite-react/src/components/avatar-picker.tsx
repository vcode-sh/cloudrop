import { IconUser } from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { orpc } from "@/lib/orpc";
import { useUpload } from "@/lib/upload";
import { cn } from "@/lib/utils";
import { UploadRow } from "./upload-row";
import { useRefreshFilesWhenDone } from "./use-refresh-files";

/** The avatar route: one image of at most 2 MB, sent in one PUT; the server keeps the newest and deletes the last. */
export function AvatarPicker() {
  const avatar = useQuery(orpc.files.avatar.queryOptions());
  const { files, totals, getInputProps } = useUpload("avatar", { accept: "image/*" });
  useRefreshFilesWhenDone(totals.done);
  const latest = files.at(-1);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Avatar</CardTitle>
        <CardDescription>An image of at most 2 MB.</CardDescription>
      </CardHeader>
      <CardContent className="flex items-center gap-4">
        <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted">
          {avatar.data ? (
            <img src={avatar.data.url} alt="Your avatar" className="size-full object-cover" />
          ) : (
            <IconUser aria-label="No avatar yet" />
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <label className={cn(buttonVariants({ variant: "outline" }), "self-start")}>
            Choose an image
            <input {...getInputProps()} aria-label="Choose an avatar" className="sr-only" />
          </label>
          {latest && <UploadRow file={latest} />}
        </div>
      </CardContent>
    </Card>
  );
}
