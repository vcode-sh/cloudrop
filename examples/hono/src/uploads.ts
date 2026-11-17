// cloudrop's server for the app: two routes on the Drizzle store, built by the composition root (src/index.ts) from its
// dependencies. The web app imports only its type (src/types.ts), so no server code or secret reaches the browser.
import { createCloudrop, type StorageDriver, unauthorized } from "cloudrop";
import { drizzleStore } from "cloudrop/adapters/drizzle";
import { eq } from "drizzle-orm";
import type { Database } from "./db/client";
import { avatar } from "./db/schema";

/** The session behind the request's cookie: better-auth's `auth.api.getSession`. */
export type ReadSession = (headers: Headers) => Promise<{ user: { id: string } } | null>;

export interface UploadsDeps {
  db: Database;
  storage: StorageDriver;
  readSession: ReadSession;
  /** The web app's origin: it calls the handler from another origin with cookies. */
  webOrigin: string;
  quotaBytes: number;
}

export function createUploads(deps: UploadsDeps) {
  // A transaction per completion, so onComplete's writes through `tx` commit with cloudrop's record or not at all.
  const store = drizzleStore(deps.db, { dialect: "postgres", transaction: true });
  const signedIn = async ({ request }: { request: Request }) => {
    const session = await deps.readSession(request.headers);
    return session ? { userId: session.user.id } : unauthorized("Sign in to upload files.");
  };

  const uploads = createCloudrop({
    storage: deps.storage,
    store,
    // Each user's files count toward this, avatars included; a file that does not fit is refused at /upload.
    quota: () => deps.quotaBytes,
    trustedOrigins: [deps.webOrigin],
    // Small enough that the demo shows parts with a 20 MiB file; leave the default (64 MiB) in an app.
    multipartThreshold: "8MB",
    routes: {
      avatar: store.route(
        { accept: "image/*", maxSize: "2MB", maxFiles: 1, authorize: signedIn },
        {
          prefix: ({ userId }) => `users/${userId}/avatar`,
          owner: ({ userId }) => userId,
          onComplete: async ({ tx, userId, file }) => {
            // FOR UPDATE: two replacements of one avatar take turns, so each deletes the file it replaced. Two
            // first avatars at once still race (no row to lock): the loser's file stays in the list for a delete.
            const [previous] = await tx
              .select({ fileId: avatar.fileId })
              .from(avatar)
              .where(eq(avatar.userId, userId))
              .for("update");
            const row = { key: file.key, fileId: file.id, updatedAt: new Date() };
            await tx
              .insert(avatar)
              .values({ userId, ...row })
              .onConflictDoUpdate({ target: avatar.userId, set: row });
            return { replaced: previous?.fileId ?? null };
          },
          // After the record commits: the old avatar's object and its bytes in the quota go. A storage call, so not in
          // onComplete, whose transaction would wait for it. If it fails, the old file stays in the list for a delete.
          afterComplete: async ({ data }) => {
            if (!data.replaced) return;
            const { error } = await uploads.api.deleteFile(data.replaced);
            if (error) console.warn(`Could not delete the replaced avatar ${data.replaced}: ${error.message}`);
          },
        },
      ),
      attachments: store.route(
        { accept: "*/*", maxSize: "100MB", maxFiles: 10, authorize: signedIn },
        {
          prefix: ({ userId }) => `users/${userId}/attachments`,
          owner: ({ userId }) => userId,
        },
      ),
    },
  });
  return uploads;
}

export type Uploads = ReturnType<typeof createUploads>;
