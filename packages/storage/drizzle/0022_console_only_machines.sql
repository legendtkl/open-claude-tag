-- D-A7: console-only machine management. Machines are owned solely by the console
-- platform_user; pairing + binding move into the admin console. The legacy Feishu
-- openId ownership / issuance columns become nullable (kept for any existing rows,
-- never dropped).

-- machines: add platform ownership, relax legacy openId ownership to nullable.
ALTER TABLE "machines" ADD COLUMN "platform_owner_id" uuid;
--> statement-breakpoint
ALTER TABLE "machines" ALTER COLUMN "owner_open_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_platform_owner_id_platform_users_id_fk" FOREIGN KEY ("platform_owner_id") REFERENCES "public"."platform_users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_machines_platform_owner" ON "machines" USING btree ("platform_owner_id");
--> statement-breakpoint

-- machine_pairing_tokens: add console issuer, relax legacy openId/chat to nullable.
ALTER TABLE "machine_pairing_tokens" ADD COLUMN "platform_issuer_id" uuid;
--> statement-breakpoint
ALTER TABLE "machine_pairing_tokens" ALTER COLUMN "issuer_open_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "machine_pairing_tokens" ALTER COLUMN "chat_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "machine_pairing_tokens" ADD CONSTRAINT "machine_pairing_tokens_platform_issuer_id_platform_users_id_fk" FOREIGN KEY ("platform_issuer_id") REFERENCES "public"."platform_users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_machine_pairing_tokens_platform_issuer" ON "machine_pairing_tokens" USING btree ("platform_issuer_id");
