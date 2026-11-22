ALTER TABLE "cloudrop_usage" ADD COLUMN "erase_requested_at" timestamp(3) with time zone;--> statement-breakpoint
ALTER TABLE "cloudrop_usage" ADD COLUMN "erased_at" timestamp(3) with time zone;--> statement-breakpoint
CREATE INDEX "cloudrop_usage_erasing_idx" ON "cloudrop_usage" ("owner") WHERE "erase_requested_at" IS NOT NULL AND "erased_at" IS NULL;