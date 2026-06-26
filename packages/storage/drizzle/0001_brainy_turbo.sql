ALTER TABLE "sessions" ADD COLUMN "sdk_session_id" varchar(256);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "runtime_backend" varchar(32);