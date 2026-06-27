-- Retention support for channel_observations: a per-scope recency index covering
-- the full read order, so the reconciler prune (protect newest keepFloor, delete
-- oldest surplus) and the existing recency read both run as index scans without a
-- sort. Additive only; existing indexes are kept.
CREATE INDEX IF NOT EXISTS "idx_channel_observations_scope_recency" ON "channel_observations" ("channel_kind","scope_id","occurred_at","created_at","id");
