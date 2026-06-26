import type { TaskSpec, RuntimeEvent, ArtifactRef } from '@open-tag/core-types';

export interface WorkspaceContext {
  runId: string;
  /**
   * Scratch directory the adapter is allowed to write into (TASK.md, image.png,
   * artifacts, etc.). Always inside `WORKSPACES_ROOT`; never the user's repo.
   */
  workspacePath: string;
  /**
   * Directory the agent process runs in. Defaults to `workspacePath` when not
   * set. Set this separately when the agent should `cd` into a real repo (e.g.
   * a git worktree, or a read-only project root) while adapter scratch writes
   * stay in `workspacePath`.
   */
  cwd?: string;
  /**
   * When true, the adapter should run the readonly workflow against `cwd`
   * without creating a write worktree. Runtimes may deny direct file-editing
   * tools, but Bash/read-only diagnostics should remain available.
   */
  readOnly?: boolean;
  /** Environment variables injected into the runtime process for this task. */
  runtimeEnv?: Record<string, string>;
  inputDir: string;
  outputDir: string;
  repoDir: string;
  artifactsDir: string;
  logsDir: string;
}

export interface RuntimeHandle {
  executionId: string;
  /** Scratch directory (see WorkspaceContext.workspacePath). */
  workspacePath: string;
  /** Resolved agent cwd. Set by adapter.prepare() from workspace.cwd ?? workspace.workspacePath. */
  cwd: string;
  /** Whether this run should use the readonly workflow. */
  readOnly: boolean;
  /** Environment variables injected into the runtime process for this task. */
  runtimeEnv?: Record<string, string>;
  /** Local image paths prepared for runtimes that accept explicit image input. */
  imagePaths?: string[];
  pid?: number;
}

export interface RuntimeResumeOptions {
  taskId?: string;
  executionId?: string;
  /** Local image paths prepared for this resumed turn. */
  imagePaths?: string[];
  /** Per-task model override (from the agent profile) for this resumed turn. */
  model?: string;
}

export interface HealthStatus {
  healthy: boolean;
  name: string;
  message?: string;
  lastCheckedAt: Date;
}

export type RuntimeCancelOutcome =
  | 'termination_started'
  | 'terminated'
  | 'no_active_execution'
  | 'already_done';

export interface RuntimeCancelOptions {
  /**
   * Escalate immediately to OS-level termination when a child process is known.
   * Used by watchdog recovery after cooperative cancellation has not produced a
   * terminal runtime event.
   */
  force?: boolean;
}

export interface RuntimeAdapter {
  name(): string;
  prepare(spec: TaskSpec, workspace: WorkspaceContext): Promise<RuntimeHandle>;
  execute(
    handle: RuntimeHandle,
    spec: TaskSpec,
    systemPromptAppend?: string,
  ): AsyncGenerator<RuntimeEvent>;
  cancel(executionId: string, options?: RuntimeCancelOptions): Promise<RuntimeCancelOutcome>;
  collectArtifacts(executionId: string): Promise<ArtifactRef[]>;
  healthcheck(): Promise<HealthStatus>;

  /** Whether this adapter supports resuming a previous SDK session */
  supportsResume(): boolean;

  /** Resume a previous SDK session with a new prompt */
  resume(
    sdkSessionId: string,
    prompt: string,
    workspace: WorkspaceContext,
    systemPromptAppend?: string,
    options?: RuntimeResumeOptions,
  ): AsyncGenerator<RuntimeEvent>;
}
