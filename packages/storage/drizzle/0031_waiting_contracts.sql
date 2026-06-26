-- Waiting contracts: a deferred agent's promise (created at multi-mention
-- intake) to act after the primary agent completes. Consumed by the worker
-- completion hook (waiting -> woken posts the visible wake mention) and the
-- contract reconciler (waiting -> expired/cancelled, always visibly).
CREATE TABLE "waiting_contracts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_key" varchar(64) DEFAULT 'default' NOT NULL,
  "chat_id" varchar(128) NOT NULL,
  "message_id" varchar(128) NOT NULL,
  "session_id" uuid,
  "agent_id" uuid NOT NULL,
  "feishu_app_id" uuid,
  "waiting_on_agent_id" uuid NOT NULL,
  "primary_task_id" uuid,
  "goal" text NOT NULL,
  "ack_message_id" varchar(128),
  "status" varchar(16) DEFAULT 'waiting' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "waiting_contracts" ADD CONSTRAINT "waiting_contracts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "waiting_contracts" ADD CONSTRAINT "waiting_contracts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "waiting_contracts" ADD CONSTRAINT "waiting_contracts_feishu_app_id_feishu_apps_id_fk" FOREIGN KEY ("feishu_app_id") REFERENCES "public"."feishu_apps"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "waiting_contracts" ADD CONSTRAINT "waiting_contracts_waiting_on_agent_id_agents_id_fk" FOREIGN KEY ("waiting_on_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "waiting_contracts" ADD CONSTRAINT "waiting_contracts_primary_task_id_tasks_id_fk" FOREIGN KEY ("primary_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_waiting_contracts_message_agent" ON "waiting_contracts" USING btree ("tenant_key","chat_id","message_id","agent_id");
--> statement-breakpoint
CREATE INDEX "idx_waiting_contracts_primary_task" ON "waiting_contracts" USING btree ("primary_task_id");
--> statement-breakpoint
CREATE INDEX "idx_waiting_contracts_waiting_on" ON "waiting_contracts" USING btree ("waiting_on_agent_id","status");
--> statement-breakpoint
CREATE INDEX "idx_waiting_contracts_status_created" ON "waiting_contracts" USING btree ("status","created_at");
