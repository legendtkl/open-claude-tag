CREATE TABLE IF NOT EXISTS "identity_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" varchar(256) NOT NULL,
	"period" varchar(8) NOT NULL,
	"window_key" varchar(16) NOT NULL,
	"tokens_used" bigint DEFAULT 0 NOT NULL,
	"spend_used" numeric DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_identity_usage_window" ON "identity_usage" ("identity_id","period","window_key");
