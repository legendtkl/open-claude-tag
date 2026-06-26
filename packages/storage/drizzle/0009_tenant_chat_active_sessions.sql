ALTER TABLE "chat_active_sessions" ADD COLUMN "tenant_key" varchar(128);
--> statement-breakpoint
UPDATE "chat_active_sessions" AS cas
SET "tenant_key" = COALESCE(
  substring(s."session_key" from '^feishu:([^:]+):'),
  'default'
)
FROM "sessions" AS s
WHERE cas."active_session_id" = s."id";
--> statement-breakpoint
UPDATE "chat_active_sessions"
SET "tenant_key" = 'default'
WHERE "tenant_key" IS NULL;
--> statement-breakpoint
ALTER TABLE "chat_active_sessions" ALTER COLUMN "tenant_key" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_active_sessions" ALTER COLUMN "tenant_key" SET DEFAULT 'default';
--> statement-breakpoint
ALTER TABLE "chat_active_sessions" DROP CONSTRAINT "chat_active_sessions_pkey";
--> statement-breakpoint
ALTER TABLE "chat_active_sessions" ADD CONSTRAINT "chat_active_sessions_tenant_key_chat_id_pk" PRIMARY KEY("tenant_key","chat_id");
--> statement-breakpoint
CREATE INDEX "idx_chat_active_sessions_chat" ON "chat_active_sessions" USING btree ("chat_id");
