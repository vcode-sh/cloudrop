// cloudrop's server for the app: two routes on the Drizzle store, built by the composition root (src/index.ts) from its
// dependencies. The web app imports only its type (src/types.ts), so no server code or secret reaches the browser.
import { createCloudrop, type StorageDriver, unauthorized } from "cloudrop";
import { drizzleStore } from "cloudrop/adapters/drizzle";
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

  return createCloudrop({
    storage: deps.storage,
    store,
    // Each user's files count toward this, avatars included; a file that does not fit is refused at /upload.
    quota: () => deps.quotaBytes,
    trustedOrigins: [deps.webOrigin],
    // Small enough that the demo shows parts with a 20 MiB file; leave the default (64 MiB) in an app.
    multipartThreshold: "8MB",
    routes: {
      // replace: one avatar per user. The completion that records a new avatar deletes the previous one in the same
      // transaction, its bytes leave the quota, and its object is removed right after (by the sweep if that fails).
      avatar: store.route(
        { accept: "image/*", maxSize: "2MB", replace: true, authorize: signedIn },
        {
          prefix: ({ userId }) => `users/${userId}/avatar`,
          owner: ({ userId }) => userId,
          // The avatar row commits with cloudrop's record of the completion, or neither does. Two avatars completing at
          // once take turns on this row, so the one recorded last is both the row and the file that stays.
          onComplete: async ({ tx, userId, file }) => {
            const row = { key: file.key, fileId: file.id, updatedAt: new Date() };
            await tx
              .insert(avatar)
              .values({ userId, ...row })
              .onConflictDoUpdate({ target: avatar.userId, set: row });
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
}

export type Uploads = ReturnType<typeof createUploads>;
