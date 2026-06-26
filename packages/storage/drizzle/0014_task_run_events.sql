CREATE TABLE "task_run_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"event_index" integer NOT NULL,
	"event_type" varchar(32) NOT NULL,
	"message" text,
	"progress" real,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "task_run_events" ADD CONSTRAINT "task_run_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_run_events" ADD CONSTRAINT "task_run_events_run_id_task_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."task_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_task_run_events_run_index" ON "task_run_events" USING btree ("run_id","event_index");--> statement-breakpoint
CREATE INDEX "idx_task_run_events_task" ON "task_run_events" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_task_run_events_run" ON "task_run_events" USING btree ("run_id");
