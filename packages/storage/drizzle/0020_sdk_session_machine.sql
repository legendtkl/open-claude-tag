ALTER TABLE "sessions" ADD COLUMN "sdk_session_machine_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_session_states" ADD COLUMN "sdk_session_machine_id" uuid;
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_sdk_session_machine_id_machines_id_fk" FOREIGN KEY ("sdk_session_machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agent_session_states" ADD CONSTRAINT "agent_session_states_sdk_session_machine_id_machines_id_fk" FOREIGN KEY ("sdk_session_machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;
