// The app's own record of a finished avatar upload: one row per user, written by the avatar route's onComplete in the
// same transaction as cloudrop's record of the completion.
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

export const avatar = pgTable("avatar", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** The object's key in the bucket. */
  key: text("key").notNull(),
  /** cloudrop's file id, for `cloudrop.api.deleteFile` when the user deletes the avatar. */
  fileId: text("file_id").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull(),
});
