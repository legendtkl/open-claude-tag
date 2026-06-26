CREATE TABLE "admission_leases" (
	"task_id" uuid PRIMARY KEY NOT NULL,
	"agent_id" uuid,
	"session_id" uuid NOT NULL,
	"job_data" jsonb NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"lease_owner" varchar(128),
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "admission_leases" ADD CONSTRAINT "admission_leases_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admission_leases" ADD CONSTRAINT "admission_leases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "admission_leases" ADD CONSTRAINT "admission_leases_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_admission_leases_due" ON "admission_leases" USING btree ("not_before");
--> statement-breakpoint
CREATE INDEX "idx_admission_leases_agent" ON "admission_leases" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX "idx_admission_leases_session" ON "admission_leases" USING btree ("session_id");
