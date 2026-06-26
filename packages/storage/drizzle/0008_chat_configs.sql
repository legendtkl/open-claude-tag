CREATE TABLE "chat_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_key" varchar(128) NOT NULL,
	"chat_id" varchar(64) NOT NULL,
	"default_work_dir" varchar(1024),
	"default_runtime" varchar(32),
	"created_by_open_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_chat_configs_tenant_chat" ON "chat_configs" USING btree ("tenant_key","chat_id");--> statement-breakpoint
CREATE INDEX "idx_chat_configs_chat" ON "chat_configs" USING btree ("chat_id");
