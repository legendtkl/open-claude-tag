-- Per-agent runtime environment variables. Values are injected into the
-- selected runtime process for tasks owned by the agent.

ALTER TABLE "agents" ADD COLUMN "runtime_env" jsonb DEFAULT '{}'::jsonb NOT NULL;
