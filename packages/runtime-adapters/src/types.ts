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
  /**
   * Canonical scratch artifacts directory (`WorkspaceContext.artifactsDir`). The
   * adapter scans EXACTLY this dir for output artifacts so the events it emits
   * agree with what the worker/daemon persist. Never `cwd/artifacts`: in real
   * modes `cwd` is a worktree / external repo / agent home and scanning it would
   * both diverge from the persistence scan and pick up unrelated pre-existing
   * files (artifact-table bloat), violating the scratch-only invariant above.
   */
  artifactsDir: string;
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

export type RuntimeSandboxMode = 'readonly' | 'workspace-write' | 'danger-full-access';

/**
 * Open, data-driven description of a runtime backend. Lets the platform select,
 * gate, and render a runtime from data instead of branching on name strings.
 *
 * `id` is the OPEN display/registry id (`claude-code` | `codex`, hyphen form). It
 * is deliberately distinct from {@link RuntimeAdapter.name}, which is the
 * PERSISTED key written to `sessions.runtimeBackend` (`claude_code` underscore,
 * `codex`) and must never change. `workflowPrompts` carries workflow *refs*
 * (basenames loadable via `loadWorkflow`), never inline prompts.
 */
export interface RuntimeDescriptor {
  /** Open display/registry id (`claude-code` | `codex`). NOT the persisted `name()`. */
  id: string;
  displayName: string;
  capabilities: {
    /** Can resume a previous SDK/CLI session for a follow-up turn. */
    resume: boolean;
    /** Hard-enforces read-only mode (denies file-mutating tools), not merely advisory. */
    enforcesReadOnly: boolean;
    /** Supports an interactive per-tool permission decision (e.g. canUseTool). */
    interactivePermission: boolean;
    /** Sandbox modes the adapter actually drives. */
    sandboxModes: ReadonlyArray<RuntimeSandboxMode>;
    /** How prepared images are handed to the runtime. */
    imageInput: 'base64' | 'local-path' | 'none';
    /** Accepts a per-task model override. */
    modelSelection: boolean;
  };
  /** Credential env-var NAMES the runtime reads (values are never carried here). */
  credentialEnv: string[];
  /** Workflow prompt refs (basenames for `loadWorkflow`), not inline prompt bodies. */
  workflowPrompts?: { selfDev?: string; readonly?: string; default?: string };
}

export interface RuntimeAdapter {
  name(): string;
  /** Open, data-driven capability descriptor (distinct from the persisted `name()`). */
  descriptor(): RuntimeDescriptor;
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

/**
 * One runtime's contribution to a {@link RuntimeAdapter} registry. `isAvailable()`
 * gates registration (e.g. a CLI binary is resolvable); `create()` builds the
 * adapter lazily so an unavailable runtime never constructs. Consumed by
 * `buildRuntimeManager`.
 */
export interface RuntimeRegistration {
  isAvailable(): boolean;
  create(): RuntimeAdapter;
}
