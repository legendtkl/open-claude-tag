CREATE TABLE IF NOT EXISTS "identity_access_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" varchar(256) NOT NULL,
	"bundle_id" varchar(128) NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_identity_access_grants_identity_bundle" ON "identity_access_grants" ("identity_id","bundle_id");
