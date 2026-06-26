ALTER TABLE "tasks" ADD COLUMN "feedback_message_id" varchar(64);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "feedback_card_type" varchar(32);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "feedback_state" varchar(32);--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "feedback_updated_at" timestamp with time zone;