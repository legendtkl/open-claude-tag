CREATE TABLE "machines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_key" text NOT NULL,
	"owner_open_id" text NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"status" varchar(16) DEFAULT 'offline' NOT NULL,
	"capabilities" jsonb DEFAULT '{"runtimes":[]}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_pairing_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"tenant_key" text NOT NULL,
	"issuer_open_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"machine_name" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "machine_pairing_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "bound_machine_id" uuid;
--> statement-breakpoint
ALTER TABLE "chat_configs" ADD COLUMN "default_machine_id" uuid;
--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "executed_on_machine_id" uuid;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_bound_machine_id_machines_id_fk" FOREIGN KEY ("bound_machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "chat_configs" ADD CONSTRAINT "chat_configs_default_machine_id_machines_id_fk" FOREIGN KEY ("default_machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_executed_on_machine_id_machines_id_fk" FOREIGN KEY ("executed_on_machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_machines_owner_name" ON "machines" USING btree ("tenant_key","owner_open_id","name");
--> statement-breakpoint
CREATE INDEX "idx_machines_owner" ON "machines" USING btree ("tenant_key","owner_open_id");
--> statement-breakpoint
CREATE INDEX "idx_machines_status" ON "machines" USING btree ("status");
--> statement-breakpoint
CREATE INDEX "idx_machine_pairing_tokens_issuer" ON "machine_pairing_tokens" USING btree ("tenant_key","issuer_open_id");
--> statement-breakpoint
CREATE INDEX "idx_machine_pairing_tokens_expires" ON "machine_pairing_tokens" USING btree ("expires_at");
