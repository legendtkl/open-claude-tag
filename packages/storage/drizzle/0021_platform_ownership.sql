CREATE TABLE "platform_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sso_sub" text NOT NULL,
	"email" text,
	"display_name" text,
	"department" text,
	"role" varchar(16) DEFAULT 'user' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "platform_users_sso_sub_unique" UNIQUE("sso_sub")
);
--> statement-breakpoint
ALTER TABLE "feishu_apps" ADD COLUMN "platform_owner_id" uuid;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "platform_owner_id" uuid;
--> statement-breakpoint
ALTER TABLE "feishu_apps" ADD CONSTRAINT "feishu_apps_platform_owner_id_platform_users_id_fk" FOREIGN KEY ("platform_owner_id") REFERENCES "public"."platform_users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_platform_owner_id_platform_users_id_fk" FOREIGN KEY ("platform_owner_id") REFERENCES "public"."platform_users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_platform_users_email" ON "platform_users" USING btree ("email");
