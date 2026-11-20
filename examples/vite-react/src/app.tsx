import { QueryClientProvider } from "@tanstack/react-query";
import { authClient } from "@/lib/auth-client";
import { queryClientFor } from "@/lib/orpc";
import { UploadsContext, uploadsFor, useCloseOtherUsers } from "@/lib/upload";
import { AuthPanel } from "./components/auth-panel";
import { AvatarPicker } from "./components/avatar-picker";
import { DropZone } from "./components/drop-zone";
import { FilesTable } from "./components/files-table";
import { UnfinishedUploads } from "./components/unfinished-uploads";

export function App() {
  const session = authClient.useSession();
  const email = session.data?.user.email ?? null;
  const userId = session.data?.user.id ?? "";
  useCloseOtherUsers(userId);

  // Keyed by the user: a new user gets fresh hooks and a fresh query cache, with none of the last user's uploads or
  // files in memory.
  return (
    <UploadsContext key={userId} value={uploadsFor(userId)}>
      <QueryClientProvider client={queryClientFor(userId)}>
        <main className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
          <header className="flex flex-wrap items-center justify-between gap-4">
            <h1 className="text-xl font-semibold">cloudrop with Hono and Vite</h1>
            {!session.isPending && email && <AuthPanel email={email} />}
          </header>
          {!session.isPending && !email && <AuthPanel email={null} />}
          {/* Shown signed out too: an upload then gets cloudrop's UNAUTHORIZED with the route's message. */}
          <DropZone />
          {email && (
            <>
              <UnfinishedUploads />
              <AvatarPicker />
              <FilesTable />
            </>
          )}
        </main>
      </QueryClientProvider>
    </UploadsContext>
  );
}
