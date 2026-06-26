CREATE TABLE "feishu_webhook_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"nonce" varchar(128) NOT NULL,
	"feishu_app_id" uuid,
	"app_id" varchar(128),
	"event_id" varchar(128),
	"timestamp_seconds" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feishu_card_action_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"dedup_key" varchar(256) NOT NULL,
	"source_task_id" uuid NOT NULL,
	"new_task_id" uuid,
	"action" varchar(64) NOT NULL,
	"operator_open_id" varchar(128),
	"event_id" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "feishu_webhook_receipts" ADD CONSTRAINT "feishu_webhook_receipts_feishu_app_id_feishu_apps_id_fk" FOREIGN KEY ("feishu_app_id") REFERENCES "public"."feishu_apps"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "feishu_card_action_receipts" ADD CONSTRAINT "feishu_card_action_receipts_source_task_id_tasks_id_fk" FOREIGN KEY ("source_task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_webhook_receipts_nonce" ON "feishu_webhook_receipts" USING btree ("nonce");
--> statement-breakpoint
CREATE INDEX "idx_feishu_webhook_receipts_created" ON "feishu_webhook_receipts" USING btree ("created_at");
--> statement-breakpoint
CREATE INDEX "idx_feishu_webhook_receipts_app_event" ON "feishu_webhook_receipts" USING btree ("feishu_app_id","event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_feishu_card_action_receipts_dedup" ON "feishu_card_action_receipts" USING btree ("dedup_key");
--> statement-breakpoint
CREATE INDEX "idx_feishu_card_action_receipts_source_task" ON "feishu_card_action_receipts" USING btree ("source_task_id");
--> statement-breakpoint
CREATE INDEX "idx_feishu_card_action_receipts_new_task" ON "feishu_card_action_receipts" USING btree ("new_task_id");
