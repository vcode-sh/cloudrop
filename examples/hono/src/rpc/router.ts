// The app's oRPC router, mounted at /rpc/*. `files` lists and deletes the signed-in user's uploads: it reads cloudrop's
// table through Drizzle, which the store guide allows, and changes files only through cloudrop's file API, which keeps
// each user's usage in step.
import { ORPCError, os } from "@orpc/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { avatar, cloudropFiles } from "../db/schema";
import type { Uploads } from "../uploads";

export interface RpcContext {
  /** The signed-in user, from the request's session; null when signed out. */
  userId: string | null;
  db: Database;
  files: Uploads["api"];
}

/** How long a signed avatar URL stays valid: the page asks again after a reload. */
const AVATAR_URL_SECONDS = 600;

const signedIn = os.$context<RpcContext>().use(({ context, next }) => {
  if (!context.userId) throw new ORPCError("UNAUTHORIZED", { message: "Sign in to see your files." });
  return next({ context: { userId: context.userId } });
});

export const router = {
  files: {
    /** The user's completed uploads, newest first. */
    list: signedIn.handler(({ context }) =>
      context.db
        .select({
          id: cloudropFiles.id,
          route: cloudropFiles.route,
          name: cloudropFiles.name,
          type: cloudropFiles.type,
          size: cloudropFiles.size,
        })
        .from(cloudropFiles)
        .where(and(eq(cloudropFiles.owner, context.userId), eq(cloudropFiles.status, "completed")))
        .orderBy(desc(cloudropFiles.completedAt), cloudropFiles.id),
    ),

    /** Deletes one of the user's files: its object, its row's status and its bytes in the quota. */
    delete: signedIn.input(z.object({ id: z.string().min(1).max(64) })).handler(async ({ context, input }) => {
      const { data: file, error } = await context.files.file(input.id);
      if (error) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: error.message });
      if (file?.owner !== context.userId || file.status !== "completed") {
        throw new ORPCError("NOT_FOUND", { message: "This file does not exist or was already deleted." });
      }
      const deleted = await context.files.deleteFile(input.id);
      if (deleted.error) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: deleted.error.message });
      await context.db.delete(avatar).where(and(eq(avatar.userId, context.userId), eq(avatar.fileId, input.id)));
      return { id: input.id };
    }),

    /** A short-lived URL of the user's avatar, or null without one. */
    avatar: signedIn.handler(async ({ context }) => {
      const [row] = await context.db.select({ key: avatar.key }).from(avatar).where(eq(avatar.userId, context.userId));
      if (!row) return null;
      const { data, error } = await context.files.getUrl(row.key, { expiresIn: AVATAR_URL_SECONDS });
      if (error) throw new ORPCError("INTERNAL_SERVER_ERROR", { message: error.message });
      return { url: data.url };
    }),
  },
};

export type AppRouter = typeof router;
