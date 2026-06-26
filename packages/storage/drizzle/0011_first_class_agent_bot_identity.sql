CREATE TABLE "agent_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(64) NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"description" text,
	"system_prompt" text,
	"style_prompt" text,
	"skill_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"default_runtime" varchar(32),
	"default_model" varchar(128),
	"source_type" varchar(32) DEFAULT 'builtin' NOT NULL,
	"source_uri" varchar(1024),
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_apps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_key" varchar(128) DEFAULT 'default' NOT NULL,
	"app_id" varchar(128) NOT NULL,
	"app_secret_ref" varchar(256) NOT NULL,
	"bot_open_id" varchar(64),
	"bot_name" varchar(128),
	"event_mode" varchar(32) DEFAULT 'websocket' NOT NULL,
	"status" varchar(16) DEFAULT 'enabled' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_key" varchar(128) DEFAULT 'default' NOT NULL,
	"scope_type" varchar(16) DEFAULT 'system' NOT NULL,
	"scope_id" varchar(256) DEFAULT 'default' NOT NULL,
	"handle" varchar(64) NOT NULL,
	"display_name" varchar(128) NOT NULL,
	"description" text,
	"profile_id" uuid NOT NULL,
	"owner_user_id" uuid,
	"visibility" varchar(16) DEFAULT 'public' NOT NULL,
	"default_runtime" varchar(32),
	"default_work_dir" varchar(1024),
	"project_id" uuid,
	"access_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_bot_bindings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"feishu_app_id" uuid NOT NULL,
	"bot_open_id" varchar(64),
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_session_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"runtime_backend" varchar(32),
	"sdk_session_id" varchar(256),
	"workspace_path" varchar(512),
	"worktree_branch" varchar(128),
	"adhoc_work_dir" varchar(1024),
	"summary" text,
	"last_run_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"tenant_key" varchar(128) DEFAULT 'default' NOT NULL,
	"feishu_app_id" uuid NOT NULL,
	"open_id" varchar(64) NOT NULL,
	"union_id" varchar(64),
	"display_name" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_configs" ADD COLUMN "default_agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "feishu_app_id" uuid;
--> statement-breakpoint
ALTER TABLE "inbound_events" ADD COLUMN "id" uuid DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "inbound_events" ADD COLUMN "feishu_app_id" uuid;
--> statement-breakpoint
ALTER TABLE "inbound_events" DROP CONSTRAINT "inbound_events_pkey";
--> statement-breakpoint
ALTER TABLE "inbound_events" ALTER COLUMN "id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_pkey" PRIMARY KEY("id");
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "agent_id" uuid;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "feishu_app_id" uuid;
--> statement-breakpoint
ALTER TABLE "task_steps" ADD COLUMN "agent_id" uuid;
--> statement-breakpoint
CREATE TABLE "agent_delegations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_task_id" uuid NOT NULL,
	"child_task_id" uuid,
	"caller_agent_id" uuid NOT NULL,
	"callee_agent_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"input_summary" text,
	"permission_scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_profile_id_agent_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_bot_bindings" ADD CONSTRAINT "agent_bot_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_bot_bindings" ADD CONSTRAINT "agent_bot_bindings_feishu_app_id_feishu_apps_id_fk" FOREIGN KEY ("feishu_app_id") REFERENCES "public"."feishu_apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_session_states" ADD CONSTRAINT "agent_session_states_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_session_states" ADD CONSTRAINT "agent_session_states_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_feishu_app_id_feishu_apps_id_fk" FOREIGN KEY ("feishu_app_id") REFERENCES "public"."feishu_apps"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_configs" ADD CONSTRAINT "chat_configs_default_agent_id_agents_id_fk" FOREIGN KEY ("default_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_feishu_app_id_feishu_apps_id_fk" FOREIGN KEY ("feishu_app_id") REFERENCES "public"."feishu_apps"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_feishu_app_id_feishu_apps_id_fk" FOREIGN KEY ("feishu_app_id") REFERENCES "public"."feishu_apps"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_feishu_app_id_feishu_apps_id_fk" FOREIGN KEY ("feishu_app_id") REFERENCES "public"."feishu_apps"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "task_steps" ADD CONSTRAINT "task_steps_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD CONSTRAINT "agent_delegations_parent_task_id_tasks_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD CONSTRAINT "agent_delegations_child_task_id_tasks_id_fk" FOREIGN KEY ("child_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD CONSTRAINT "agent_delegations_caller_agent_id_agents_id_fk" FOREIGN KEY ("caller_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_delegations" ADD CONSTRAINT "agent_delegations_callee_agent_id_agents_id_fk" FOREIGN KEY ("callee_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_profiles_name" ON "agent_profiles" USING btree ("name");
--> statement-breakpoint
CREATE INDEX "idx_agent_profiles_status" ON "agent_profiles" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_apps_app_id" ON "feishu_apps" USING btree ("app_id");
--> statement-breakpoint
CREATE INDEX "idx_feishu_apps_tenant_status" ON "feishu_apps" USING btree ("tenant_key","status");
--> statement-breakpoint
CREATE INDEX "idx_feishu_apps_bot_open_id" ON "feishu_apps" USING btree ("bot_open_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agents_scope_handle" ON "agents" USING btree ("tenant_key","scope_type","scope_id","handle");
--> statement-breakpoint
CREATE INDEX "idx_agents_profile" ON "agents" USING btree ("profile_id");
--> statement-breakpoint
CREATE INDEX "idx_agents_status" ON "agents" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_bot_bindings_active_agent" ON "agent_bot_bindings" USING btree ("agent_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_bot_bindings_active_app" ON "agent_bot_bindings" USING btree ("feishu_app_id") WHERE "status" = 'active';
--> statement-breakpoint
CREATE INDEX "idx_agent_bot_bindings_bot_open_id" ON "agent_bot_bindings" USING btree ("bot_open_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_bot_bindings_status" ON "agent_bot_bindings" USING btree ("status");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agent_session_states_agent_session" ON "agent_session_states" USING btree ("agent_id","session_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_session_states_session" ON "agent_session_states" USING btree ("session_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_user_identities_app_open" ON "user_identities" USING btree ("feishu_app_id","open_id");
--> statement-breakpoint
CREATE INDEX "idx_user_identities_union" ON "user_identities" USING btree ("union_id");
--> statement-breakpoint
CREATE INDEX "idx_user_identities_user" ON "user_identities" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "idx_chat_configs_default_agent" ON "chat_configs" USING btree ("default_agent_id");
--> statement-breakpoint
CREATE INDEX "idx_messages_agent" ON "messages" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_messages_feishu_app" ON "messages" USING btree ("feishu_app_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_inbound_events_app_event" ON "inbound_events" USING btree ("feishu_app_id","event_id");
--> statement-breakpoint
CREATE INDEX "idx_events_event_id" ON "inbound_events" USING btree ("event_id");
--> statement-breakpoint
CREATE INDEX "idx_tasks_agent" ON "tasks" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_tasks_feishu_app" ON "tasks" USING btree ("feishu_app_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_delegations_parent_task" ON "agent_delegations" USING btree ("parent_task_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_delegations_child_task" ON "agent_delegations" USING btree ("child_task_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_delegations_caller" ON "agent_delegations" USING btree ("caller_agent_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_delegations_callee" ON "agent_delegations" USING btree ("callee_agent_id");
--> statement-breakpoint
CREATE INDEX "idx_agent_delegations_status" ON "agent_delegations" USING btree ("status");
