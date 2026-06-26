ALTER TABLE "feishu_task_links" ADD COLUMN "source_topic_key" varchar(512);--> statement-breakpoint
CREATE INDEX "idx_feishu_task_links_topic" ON "feishu_task_links" USING btree ("tracking_space_id","source_topic_key");
