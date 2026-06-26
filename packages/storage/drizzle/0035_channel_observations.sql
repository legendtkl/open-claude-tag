CREATE TABLE IF NOT EXISTS "channel_observations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_kind" varchar(32) NOT NULL,
	"scope_id" varchar(256) NOT NULL,
	"source_message_id" varchar(256) NOT NULL,
	"gist" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"dedupe_hash" varchar(64) NOT NULL,
	"decay_weight" real DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_channel_observations_dedupe" ON "channel_observations" ("channel_kind","scope_id","dedupe_hash");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channel_observations_scope" ON "channel_observations" ("channel_kind","scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channel_observations_occurred" ON "channel_observations" ("occurred_at");
