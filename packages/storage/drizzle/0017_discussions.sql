CREATE TABLE "discussions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_key" varchar(128) DEFAULT 'default' NOT NULL,
	"chat_id" varchar(64) NOT NULL,
	"root_thread_id" varchar(64) NOT NULL,
	"feishu_app_id" uuid,
	"session_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"round_limit" integer DEFAULT 3 NOT NULL,
	"current_round" integer DEFAULT 1 NOT NULL,
	"current_turn_index" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discussion_participants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discussion_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"feishu_app_id" uuid,
	"bot_open_id" varchar(64),
	"display_name" varchar(128),
	"role" varchar(128),
	"order_index" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discussion_turns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discussion_id" uuid NOT NULL,
	"participant_id" uuid,
	"agent_id" uuid,
	"task_id" uuid,
	"round" integer NOT NULL,
	"turn_index" integer NOT NULL,
	"status" varchar(32) DEFAULT 'completed' NOT NULL,
	"content" text,
	"error_message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_feishu_app_id_feishu_apps_id_fk" FOREIGN KEY ("feishu_app_id") REFERENCES "public"."feishu_apps"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "discussions" ADD CONSTRAINT "discussions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "discussion_participants" ADD CONSTRAINT "discussion_participants_discussion_id_discussions_id_fk" FOREIGN KEY ("discussion_id") REFERENCES "public"."discussions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "discussion_participants" ADD CONSTRAINT "discussion_participants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "discussion_participants" ADD CONSTRAINT "discussion_participants_feishu_app_id_feishu_apps_id_fk" FOREIGN KEY ("feishu_app_id") REFERENCES "public"."feishu_apps"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "discussion_turns" ADD CONSTRAINT "discussion_turns_discussion_id_discussions_id_fk" FOREIGN KEY ("discussion_id") REFERENCES "public"."discussions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "discussion_turns" ADD CONSTRAINT "discussion_turns_participant_id_discussion_participants_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."discussion_participants"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "discussion_turns" ADD CONSTRAINT "discussion_turns_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "discussion_turns" ADD CONSTRAINT "discussion_turns_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_discussions_session" ON "discussions" USING btree ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_discussions_root" ON "discussions" USING btree ("tenant_key","chat_id","root_thread_id");
--> statement-breakpoint
CREATE INDEX "idx_discussions_chat_status" ON "discussions" USING btree ("tenant_key","chat_id","status");
--> statement-breakpoint
CREATE INDEX "idx_discussions_feishu_app" ON "discussions" USING btree ("feishu_app_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_discussion_participants_agent" ON "discussion_participants" USING btree ("discussion_id","agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_discussion_participants_order" ON "discussion_participants" USING btree ("discussion_id","order_index");
--> statement-breakpoint
CREATE INDEX "idx_discussion_participants_discussion" ON "discussion_participants" USING btree ("discussion_id");
--> statement-breakpoint
CREATE INDEX "idx_discussion_participants_agent_lookup" ON "discussion_participants" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_discussion_participants_feishu_app" ON "discussion_participants" USING btree ("feishu_app_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_discussion_turns_position" ON "discussion_turns" USING btree ("discussion_id","round","turn_index");
--> statement-breakpoint
CREATE INDEX "idx_discussion_turns_discussion" ON "discussion_turns" USING btree ("discussion_id","round","turn_index");
--> statement-breakpoint
CREATE INDEX "idx_discussion_turns_agent" ON "discussion_turns" USING btree ("agent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_discussion_turns_task" ON "discussion_turns" USING btree ("task_id");
