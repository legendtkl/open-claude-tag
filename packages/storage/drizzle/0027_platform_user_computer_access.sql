-- Admin-managed allowlist for computer/server-side execution controls. The
-- effective permission is true for superadmins regardless of this column; plain
-- users must be explicitly enabled before the console exposes machine pairing,
-- agent machine binding, chat machine defaults, or server-local execution choices.
ALTER TABLE "platform_users" ADD COLUMN "computer_access_enabled" boolean DEFAULT false NOT NULL;
