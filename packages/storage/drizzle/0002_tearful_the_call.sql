ALTER TABLE "sessions" ADD COLUMN "worktree_path" varchar(512);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "worktree_branch" varchar(128);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "pr_url" varchar(512);