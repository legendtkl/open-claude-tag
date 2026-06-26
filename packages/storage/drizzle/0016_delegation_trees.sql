CREATE TABLE "delegation_trees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"root_task_id" uuid NOT NULL,
	"total_budget" integer NOT NULL,
	"tasks_used" integer DEFAULT 0 NOT NULL,
	"fanout_budget" integer NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"resume_task_id" uuid,
	"woken_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "delegation_trees" ADD CONSTRAINT "delegation_trees_root_task_id_tasks_id_fk" FOREIGN KEY ("root_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "delegation_trees" ADD CONSTRAINT "delegation_trees_resume_task_id_tasks_id_fk" FOREIGN KEY ("resume_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD COLUMN "tree_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD COLUMN "parent_delegation_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD COLUMN "depth" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD COLUMN "child_session_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD CONSTRAINT "agent_delegations_tree_id_delegation_trees_id_fk" FOREIGN KEY ("tree_id") REFERENCES "public"."delegation_trees"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD CONSTRAINT "agent_delegations_child_session_id_sessions_id_fk" FOREIGN KEY ("child_session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_delegation_trees_root_task" ON "delegation_trees" USING btree ("root_task_id");
--> statement-breakpoint
CREATE INDEX "idx_delegation_trees_status" ON "delegation_trees" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "idx_agent_delegations_tree" ON "agent_delegations" USING btree ("tree_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_delegations_parent_delegation" ON "agent_delegations" USING btree ("parent_delegation_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_delegations_depth" ON "agent_delegations" USING btree ("depth");
--> statement-breakpoint
CREATE INDEX "idx_agent_delegations_child_session" ON "agent_delegations" USING btree ("child_session_id");
