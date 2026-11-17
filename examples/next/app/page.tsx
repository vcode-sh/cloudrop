// The home page, built from shadcn's Attachment, Button and Progress on Base UI and Tabler icons; the upload logic is
// cloudrop's headless hooks (lib/upload.ts) in components/upload. A Server Component: the client parts are the
// components it renders.
import "./globals.css";
import { Button } from "@/components/ui/button";
import { DropZone } from "@/components/upload/drop-zone";
import { UnfinishedUploads } from "@/components/upload/unfinished-uploads";
import { UploadList } from "@/components/upload/upload-list";

export default function Page() {
  return (
    <main className="mx-auto max-w-2xl space-y-8 px-4 py-10">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-64 flex-1">
          <h1 className="font-heading font-semibold text-2xl">cloudrop example</h1>
          <p className="text-muted-foreground text-sm">
            Files go from this page straight to the bucket. The{" "}
            <a href="/lab" className="underline underline-offset-4">
              lab
            </a>{" "}
            shows each request.
          </p>
        </div>
        {/* Demo only: a stand-in for a real sign-in, see app/api/demo-sign-in/route.ts. */}
        <form method="post" action="/api/demo-sign-in">
          <Button type="submit" variant="outline">
            Sign in as the demo user
          </Button>
        </form>
      </header>
      <DropZone />
      <UnfinishedUploads />
      <UploadList />
    </main>
  );
}
