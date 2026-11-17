CREATE TABLE "account" (
	"id" text PRIMARY KEY,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp(3) with time zone,
	"refresh_token_expires_at" timestamp(3) with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"token" text NOT NULL UNIQUE,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY,
	"name" text NOT NULL,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"created_at" timestamp(3) with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp(3) with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "avatar" (
	"user_id" text PRIMARY KEY,
	"key" text NOT NULL,
	"file_id" text NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cloudrop_files" (
	"id" text PRIMARY KEY,
	"route" text NOT NULL,
	"key" text NOT NULL,
	"owner" text,
	"status" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"size" bigint NOT NULL,
	"upload_id" text,
	"metadata" text,
	"result" text,
	"claim" text,
	"claimed_at" timestamp(3) with time zone,
	"expires_at" timestamp(3) with time zone NOT NULL,
	"created_at" timestamp(3) with time zone NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	"completed_at" timestamp(3) with time zone,
	"ended_at" timestamp(3) with time zone,
	"cleaned_at" timestamp(3) with time zone,
	"request_key" text
);
--> statement-breakpoint
CREATE TABLE "cloudrop_usage" (
	"owner" text PRIMARY KEY,
	"reserved_bytes" bigint NOT NULL,
	"active_bytes" bigint NOT NULL,
	"files" integer NOT NULL,
	"updated_at" timestamp(3) with time zone NOT NULL,
	CONSTRAINT "cloudrop_usage_reserved_bytes_check" CHECK ("reserved_bytes" >= 0),
	CONSTRAINT "cloudrop_usage_active_bytes_check" CHECK ("active_bytes" >= 0),
	CONSTRAINT "cloudrop_usage_files_check" CHECK ("files" >= 0)
);
--> statement-breakpoint
CREATE INDEX "account_userId_idx" ON "account" ("user_id");--> statement-breakpoint
CREATE INDEX "session_userId_idx" ON "session" ("user_id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verification" ("identifier");--> statement-breakpoint
CREATE INDEX "cloudrop_files_status_expires_at_idx" ON "cloudrop_files" ("status","expires_at");--> statement-breakpoint
CREATE INDEX "cloudrop_files_status_claimed_at_idx" ON "cloudrop_files" ("status","claimed_at");--> statement-breakpoint
CREATE INDEX "cloudrop_files_status_cleaned_at_ended_at_idx" ON "cloudrop_files" ("status","cleaned_at","ended_at");--> statement-breakpoint
CREATE INDEX "cloudrop_files_owner_status_idx" ON "cloudrop_files" ("owner","status");--> statement-breakpoint
CREATE INDEX "cloudrop_files_key_idx" ON "cloudrop_files" ("key");--> statement-breakpoint
CREATE INDEX "cloudrop_files_route_request_key_idx" ON "cloudrop_files" ("route","request_key");--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "avatar" ADD CONSTRAINT "avatar_user_id_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE;