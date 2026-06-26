-- Agent handle uniqueness moves from scope-level (tenant + scope_type + scope_id
-- + handle, cross-user) to owner-level for console-created agents, so two
-- different users may each name an agent "Developer". Routing/handoff use the
-- agent id (UUID); the handle/display name is now just a per-owner label.
--
-- Two partial unique indexes split the responsibility by owner:
--   * console-owned (platform_owner_id NOT NULL): unique per (tenant, owner).
--   * ops / built-in (platform_owner_id NULL): keep the old scope-level rule so
--     the bootstrap/sync upsert still has a unique constraint to conflict on
--     (NULLs do not collide in the owner index).
DROP INDEX IF EXISTS "idx_agents_scope_handle";
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agents_owner_handle" ON "agents" USING btree ("tenant_key","platform_owner_id","handle") WHERE "platform_owner_id" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "idx_agents_scope_handle" ON "agents" USING btree ("tenant_key","scope_type","scope_id","handle") WHERE "platform_owner_id" IS NULL;
