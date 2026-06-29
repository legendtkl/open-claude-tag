-- Slack Milestone 1a (issue #21, ADR-0013): per-team Slack bot-token store. One
-- Slack app (signing secret stays in env) installs into MANY workspaces, each row
-- keyed on `team_id`. Modeled cell-for-cell on `feishu_apps` so the env-ref/stored
-- secret convention and the fail-closed `platform_owner_id` ownership reuse. Rows
-- are admin-CRUD created in M1a; OAuth auto-provisioning is M1b.
CREATE TABLE IF NOT EXISTS "slack_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"team_id" varchar(128) NOT NULL,
	"slack_app_id" varchar(128),
	"bot_token" text,
	"bot_token_ref" varchar(256) DEFAULT 'stored' NOT NULL,
	"bot_user_id" varchar(64),
	"team_name" varchar(128),
	"bot_name" varchar(128),
	"status" varchar(16) DEFAULT 'enabled' NOT NULL,
	"tenant_key" varchar(128),
	"platform_owner_id" uuid,
	"installation" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "slack_installations" ADD CONSTRAINT "slack_installations_platform_owner_id_platform_users_id_fk" FOREIGN KEY ("platform_owner_id") REFERENCES "public"."platform_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_slack_installations_team" ON "slack_installations" ("team_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_installations_status" ON "slack_installations" ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_slack_installations_platform_owner" ON "slack_installations" ("platform_owner_id");
