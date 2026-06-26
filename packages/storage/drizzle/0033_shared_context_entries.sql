CREATE TABLE IF NOT EXISTS "shared_context_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"scope_type" varchar(16) DEFAULT 'session' NOT NULL,
	"scope_id" varchar(256) NOT NULL,
	"author_agent_id" uuid,
	"author_agent_kind" varchar(32),
	"author_machine_id" uuid,
	"memory_type" varchar(32) DEFAULT 'fact' NOT NULL,
	"gist" text NOT NULL,
	"evidence_ref" jsonb NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_by_agent_id" uuid,
	"verify_reason" text,
	"importance_score" real DEFAULT 0.5 NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shared_context_entries" ADD CONSTRAINT "shared_context_entries_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shared_context_entries" ADD CONSTRAINT "shared_context_entries_author_agent_id_agents_id_fk" FOREIGN KEY ("author_agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shared_context_entries" ADD CONSTRAINT "shared_context_entries_author_machine_id_machines_id_fk" FOREIGN KEY ("author_machine_id") REFERENCES "machines"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "shared_context_entries" ADD CONSTRAINT "shared_context_entries_verified_by_agent_id_agents_id_fk" FOREIGN KEY ("verified_by_agent_id") REFERENCES "agents"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_shared_context_session" ON "shared_context_entries" ("session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_shared_context_scope" ON "shared_context_entries" ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_shared_context_status" ON "shared_context_entries" ("status");
