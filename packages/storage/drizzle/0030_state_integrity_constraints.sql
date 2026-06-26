-- NOTE: run with API/worker stopped (the standard deploy runbook does); the
-- approvals dedupe + unique index creation is not safe against live writers.
--
-- State-machine columns were bare varchars and approvals had no uniqueness:
-- one bad write silently corrupts a state machine, and a double-clicked
-- approval double-counts. CHECKs are NOT VALID (enforce new writes, tolerate
-- legacy rows; VALIDATE later as an ops task).
--
-- 1) Approvals: dedupe (keep the earliest row per (request, approver, action))
--    then add the partial unique index the conflict-tolerant vote insert uses.
DELETE FROM "approvals" t
USING "approvals" k
WHERE t."change_request_id" IS NOT NULL
  AND t."approver_id" IS NOT NULL
  AND t."change_request_id" = k."change_request_id"
  AND t."approver_id" = k."approver_id"
  AND t."action" = k."action"
  AND t."id" <> k."id"
  AND (t."created_at", t."id") > (k."created_at", k."id");
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_approvals_request_approver_action"
  ON "approvals" ("change_request_id", "approver_id", "action")
  WHERE "change_request_id" IS NOT NULL AND "approver_id" IS NOT NULL;
--> statement-breakpoint
-- 2) Self-referential parent links get referential integrity. SET NULL keeps
--    retry/follow-up chains from blocking deletion or cascading.
ALTER TABLE "tasks"
  ADD CONSTRAINT "tasks_parent_task_id_tasks_id_fk"
  FOREIGN KEY ("parent_task_id") REFERENCES "tasks"("id") ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "agent_delegations"
  ADD CONSTRAINT "agent_delegations_parent_delegation_id_fk"
  FOREIGN KEY ("parent_delegation_id") REFERENCES "agent_delegations"("id") ON DELETE SET NULL
  NOT VALID;
--> statement-breakpoint
-- 3) CHECK constraints for the columns whose write sets are typed enums or
--    unions in their owning module (verified there; see design).
ALTER TABLE "tasks"
  ADD CONSTRAINT "chk_tasks_status"
  CHECK ("status" IN ('pending','queued','running','waiting_approval','waiting_delegation','completed','failed','cancelled'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "inbound_events"
  ADD CONSTRAINT "chk_inbound_events_status"
  CHECK ("status" IN ('received','processed','duplicate'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "approvals"
  ADD CONSTRAINT "chk_approvals_action"
  CHECK ("action" IN ('approve','reject'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "change_requests"
  ADD CONSTRAINT "chk_change_requests_status"
  CHECK ("status" IN ('draft','planned','patched','verified','waiting_approval','applied','rolled_back','failed'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "agent_delegations"
  ADD CONSTRAINT "chk_agent_delegations_status"
  CHECK ("status" IN ('pending','running','completed','failed','rejected'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "discussions"
  ADD CONSTRAINT "chk_discussions_status"
  CHECK ("status" IN ('active','completed','cancelled','failed'))
  NOT VALID;
--> statement-breakpoint
ALTER TABLE "discussion_turns"
  ADD CONSTRAINT "chk_discussion_turns_status"
  CHECK ("status" IN ('queued','running','completed','failed','cancelled'))
  NOT VALID;
