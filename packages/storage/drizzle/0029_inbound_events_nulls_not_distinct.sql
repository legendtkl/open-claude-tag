-- Dedup must treat NULL feishu_app_id as one scope: the default NULLS DISTINCT
-- semantics let duplicate (NULL, event_id) rows insert freely, so the same
-- Feishu event was processed twice on the legacy single-app path.
--
-- NOTE: run with API/worker stopped (the standard deploy runbook does); the
-- dedupe + constraint swap is not safe against concurrent event writers.
--
-- 1) Remove existing NULL-app duplicates. Survivor preference: a row that
--    already reached 'processed' beats 'duplicate' beats 'received' (keeping
--    a received survivor over a processed one would re-open the event for
--    reprocessing after the stale window); ties keep the earliest row.
DELETE FROM "inbound_events" t
USING (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "event_id"
      ORDER BY
        CASE "status" WHEN 'processed' THEN 0 WHEN 'duplicate' THEN 1 ELSE 2 END,
        "created_at",
        "id"
    ) AS rn
  FROM "inbound_events"
  WHERE "feishu_app_id" IS NULL
) ranked
WHERE t."id" = ranked."id"
  AND ranked.rn > 1;
--> statement-breakpoint
-- 2) Replace the NULLS DISTINCT unique index with a NULLS NOT DISTINCT
--    unique constraint (PostgreSQL >= 15).
DROP INDEX IF EXISTS "idx_inbound_events_app_event";
--> statement-breakpoint
ALTER TABLE "inbound_events"
  ADD CONSTRAINT "idx_inbound_events_app_event"
  UNIQUE NULLS NOT DISTINCT ("feishu_app_id", "event_id");
