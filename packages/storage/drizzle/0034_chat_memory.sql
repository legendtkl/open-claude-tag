ALTER TABLE "chat_configs" ADD COLUMN IF NOT EXISTS "memory_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "chat_configs" ADD COLUMN IF NOT EXISTS "memory_summary_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_configs" ADD COLUMN IF NOT EXISTS "memory_summary_time" varchar(5);
--> statement-breakpoint
ALTER TABLE "chat_configs" ADD COLUMN IF NOT EXISTS "memory_summary_timezone" varchar(64) NOT NULL DEFAULT 'Asia/Shanghai';
--> statement-breakpoint
ALTER TABLE "chat_configs" ADD COLUMN IF NOT EXISTS "memory_summary_next_run_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "chat_configs" ADD COLUMN IF NOT EXISTS "memory_summary_last_run_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "chat_configs" ADD COLUMN IF NOT EXISTS "memory_summary_last_status" varchar(32);
--> statement-breakpoint
ALTER TABLE "chat_configs" ADD COLUMN IF NOT EXISTS "memory_summary_last_error" text;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_configs" ADD CONSTRAINT "chat_configs_memory_summary_agent_id_agents_id_fk" FOREIGN KEY ("memory_summary_agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_configs_memory_due" ON "chat_configs" ("memory_enabled","memory_summary_next_run_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_configs_memory_agent" ON "chat_configs" ("memory_summary_agent_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_memory_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_key" varchar(128) NOT NULL,
	"chat_id" varchar(64) NOT NULL,
	"entry_type" varchar(16) NOT NULL,
	"title" varchar(128) NOT NULL,
	"content" text NOT NULL,
	"keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"importance_score" real DEFAULT 0.5 NOT NULL,
	"source_task_id" uuid,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_memory_entries" ADD CONSTRAINT "chat_memory_entries_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_memory_scope" ON "chat_memory_entries" ("tenant_key","chat_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_memory_type" ON "chat_memory_entries" ("entry_type");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_memory_source_task" ON "chat_memory_entries" ("source_task_id");
