DROP INDEX "cloudrop_files_owner_status_idx";--> statement-breakpoint
CREATE INDEX "cloudrop_files_owner_status_created_at_idx" ON "cloudrop_files" ("owner","status","created_at");