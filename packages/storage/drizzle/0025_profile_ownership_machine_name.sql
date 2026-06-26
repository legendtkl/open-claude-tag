-- R2-6: agent profiles gain a console owner. `platform_owner_id` is nullable;
-- NULL = a builtin/shared profile (superadmin-only to mutate). A console-created
-- profile is stamped with its creator's platform_user. Listing surfaces
-- builtin/shared (NULL) + own profiles; UPDATE requires owning the profile itself
-- (not merely an agent using it), closing the cross-user mutation hole where a
-- user could attach a shared profile to their agent and then edit it for everyone.
ALTER TABLE "agent_profiles" ADD COLUMN "platform_owner_id" uuid;
--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_platform_owner_id_platform_users_id_fk" FOREIGN KEY ("platform_owner_id") REFERENCES "public"."platform_users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_agent_profiles_platform_owner" ON "agent_profiles" USING btree ("platform_owner_id");
--> statement-breakpoint

-- R2-7: platform-owned machine name uniqueness is currently app-layer only — the
-- DB unique index is `(tenant_key, owner_open_id, name)`, but console machines
-- carry `owner_open_id = NULL`, so concurrent pairings could duplicate a name for
-- one `platform_owner_id`. Add a partial unique index enforcing name uniqueness
-- per `(tenant_key, platform_owner_id)` for console-owned machines (the WHERE
-- clause excludes legacy openId-owned rows, which keep their own unique index).
CREATE UNIQUE INDEX "idx_machines_platform_owner_name" ON "machines" USING btree ("tenant_key","platform_owner_id","name") WHERE "platform_owner_id" IS NOT NULL;
