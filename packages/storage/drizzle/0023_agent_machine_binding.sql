-- D-A8: agents are bound to a machine. An agent carries `machine_id` naming the
-- machine its tasks execute on (NULL = server-local). Set in the console agent
-- create/edit form (the owner's own non-revoked machines + "server-local"), and
-- validated to be owned by the same platform_user (fail-closed, D-A3). ON DELETE
-- set null reverts bound agents to server-local when the machine row is removed.

ALTER TABLE "agents" ADD COLUMN "machine_id" uuid;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_agents_machine" ON "agents" USING btree ("machine_id");
