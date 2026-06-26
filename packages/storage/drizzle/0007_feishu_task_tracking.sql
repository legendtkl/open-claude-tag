ALTER TABLE "tasks" ADD COLUMN "interaction_reason" varchar(32);--> statement-breakpoint
CREATE TABLE "feishu_task_tracking_spaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" varchar(32) DEFAULT 'global' NOT NULL,
	"scope_id" varchar(256) DEFAULT 'default' NOT NULL,
	"tasklist_guid" varchar(128) NOT NULL,
	"status_field_guid" varchar(128) NOT NULL,
	"status_options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sections" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_task_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"tracking_space_id" uuid,
	"feishu_task_guid" varchar(128),
	"feishu_task_url" varchar(1024),
	"source_message_id" varchar(64),
	"source_topic_url" varchar(1024),
	"last_synced_status" varchar(32),
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feishu_task_links" ADD CONSTRAINT "feishu_task_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_task_links" ADD CONSTRAINT "feishu_task_links_tracking_space_id_feishu_task_tracking_spaces_id_fk" FOREIGN KEY ("tracking_space_id") REFERENCES "public"."feishu_task_tracking_spaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_task_tracking_spaces_scope" ON "feishu_task_tracking_spaces" USING btree ("scope_type","scope_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_task_tracking_spaces_tasklist" ON "feishu_task_tracking_spaces" USING btree ("tasklist_guid");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_task_links_task" ON "feishu_task_links" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_task_links_feishu_task" ON "feishu_task_links" USING btree ("feishu_task_guid");
