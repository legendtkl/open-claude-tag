import { spawn } from 'child_process';
import { writeFile } from 'fs/promises';
import { join, delimiter as pathDelimiter } from 'path';
import readline from 'readline';
import { createLogger } from '@open-tag/observability';
import { Codex } from '@openai/codex-sdk';
import type { TaskSpec, TaskResult, RuntimeEvent, ArtifactRef } from '@open-tag/core-types';
import { errorMessage } from '@open-tag/core-types';
import type {
  RuntimeAdapter,
  RuntimeDescriptor,
  RuntimeHandle,
  WorkspaceContext,
  HealthStatus,
  RuntimeResumeOptions,
  RuntimeCancelOptions,
  RuntimeCancelOutcome,
} from './types.js';
import { collectArtifactsFromDir } from './workspace.js';
import { RuntimeExecutionRegistry } from './runtime-execution-registry.js';
import {
  downloadFileAttachmentToWorkspace,
  downloadImageAttachmentsToWorkspace,
  type ImageDownloader,
} from './image-attachment.js';

const logger = createLogger('codex-adapter');

/**
 * Open capability descriptor for the Codex runtime. Codex is deliberately
 * "weaker" than Claude Code here, faithful to this adapter's real behavior:
 * read-only is advisory (the adapter always runs `danger-full-access`) and there
 * is no interactive per-tool permission (headless `codex exec`).
 */
export const CODEX_DESCRIPTOR: RuntimeDescriptor = {
  id: 'codex',
  displayName: 'Codex',
  capabilities: {
    // resumeThread()/`codex exec resume <id>` — the SDK supports resuming.
    resume: true,
    // Read-only turns are advisory only: the adapter pins danger-full-access and
    // merely keeps the non-mutating workflow prompt — it does not deny tools.
    enforcesReadOnly: false,
    // `codex exec` runs headless; no canUseTool / interactive approval is wired.
    interactivePermission: false,
    // The adapter hard-codes danger-full-access for every turn.
    sandboxModes: ['danger-full-access'],
    // Images are passed by local filesystem path (`local_image`).
    imageInput: 'local-path',
    modelSelection: true,
  },
  // The adapter injects CODEX_API_KEY; OPENAI_API_KEY is Codex's upstream default.
  // Base URL is supplied via the `openai_base_url` config arg, not an env var.
  credentialEnv: ['CODEX_API_KEY', 'OPENAI_API_KEY'],
  workflowPrompts: { selfDev: 'self-dev-codex', readonly: 'readonly', default: 'general-task' },
};

/**
 * Upper bound on waiting for stream cleanup (child kill) before settling. In
 * real runs the abort listener has already group-killed the child, so the
 * underlying generator unblocks almost immediately; the bound only protects
 * against a wedged stream.
 */
const ITERATOR_CLEANUP_TIMEOUT_MS = 2_000;
const MAX_REASONING_SUMMARY_LENGTH = 500;

export interface CodexConfig {
  binaryPath?: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  /** Optional execution timeout in milliseconds. No timeout by default. */
  timeoutMs?: number;
  /** Optional idle timeout between streamed SDK events. Defaults to 15 minutes. */
  idleTimeoutMs?: number;
  /**
   * Max ms to wait for the Codex process to establish its API connection and
   * return the first streamable event. Guards against TCP SYN_SENT hangs.
   * Default: CODEX_STARTUP_TIMEOUT_MS env or 120_000 (2 min).
   * Set to 0 to disable.
   */
  startupTimeoutMs?: number;
  cancelSigtermGraceMs?: number;
  cancelSigkillGraceMs?: number;
  /** Optional image downloader for handling image attachments in tasks. */
  imageDownloader?: ImageDownloader;
}

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const INTERNAL_ORIGINATOR_ENV = 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE';
const TYPESCRIPT_SDK_ORIGINATOR = 'codex_sdk_ts';
type CodexRunInput =
  | string
  | Array<{ type: 'text'; text: string } | { type: 'local_image'; path: string }>;

export class CodexAdapter implements RuntimeAdapter {
  private readonly config: CodexConfig;
  private readonly executions: RuntimeExecutionRegistry;

  constructor(config: CodexConfig = {}) {
    this.config = config;
    this.executions = new RuntimeExecutionRegistry({
      runtimeName: 'codex',
      sigtermGraceMs: config.cancelSigtermGraceMs,
      sigkillGraceMs: config.cancelSigkillGraceMs,
      logger,
    });
  }

  name(): string {
    return 'codex';
  }

  descriptor(): RuntimeDescriptor {
    return CODEX_DESCRIPTOR;
  }

  async prepare(spec: TaskSpec, workspace: WorkspaceContext): Promise<RuntimeHandle> {
    const taskMdPath = join(workspace.workspacePath, 'TASK.md');
    await writeFile(
      taskMdPath,
      `# Task: ${spec.goal}\n\nType: ${spec.taskType}\nSession: ${spec.sessionId}\n` +
        `\nPlace any deliverable files you want surfaced as task artifacts under: ${workspace.artifactsDir}\n`,
    );
    const imagePaths = await downloadImageAttachmentsToWorkspace({
      spec,
      workspacePath: workspace.workspacePath,
      taskMdPath,
      imageDownloader: this.config.imageDownloader,
      logger,
    });
    await downloadFileAttachmentToWorkspace({
      spec,
      workspacePath: workspace.workspacePath,
      taskMdPath,
      imageDownloader: this.config.imageDownloader,
      logger,
    });

    return {
      executionId: spec.taskId,
      workspacePath: workspace.workspacePath,
      cwd: workspace.cwd ?? workspace.workspacePath,
      artifactsDir: workspace.artifactsDir,
      readOnly: workspace.readOnly ?? false,
      runtimeEnv: workspace.runtimeEnv,
      ...(imagePaths.length > 0 ? { imagePaths } : {}),
    };
  }

  async *execute(
    handle: RuntimeHandle,
    spec: TaskSpec,
    systemPromptAppend?: string,
  ): AsyncGenerator<RuntimeEvent> {
    yield { type: 'status', message: 'Starting Codex...' };
    yield* this.runSDKTurn(
      spec.goal,
      handle.cwd,
      handle.artifactsDir,
      handle.executionId,
      spec,
      undefined,
      systemPromptAppend,
      handle.readOnly,
      handle.runtimeEnv,
      handle.imagePaths ?? [],
      spec.model ?? this.config.model,
    );
  }

  supportsResume(): boolean {
    return true;
  }

  async *resume(
    sdkSessionId: string,
    prompt: string,
    workspace: WorkspaceContext,
    systemPromptAppend?: string,
    options: RuntimeResumeOptions = {},
  ): AsyncGenerator<RuntimeEvent> {
    yield { type: 'status', message: 'Resuming Codex session...' };
    yield* this.runSDKTurn(
      prompt,
      workspace.cwd ?? workspace.workspacePath,
      workspace.artifactsDir,
      options.executionId ?? options.taskId ?? `resume-${Date.now()}`,
      undefined,
      sdkSessionId,
      systemPromptAppend,
      workspace.readOnly ?? false,
      workspace.runtimeEnv,
      options.imagePaths ?? [],
      options.model ?? this.config.model,
    );
  }

  async cancel(
    executionId: string,
    options: RuntimeCancelOptions = {},
  ): Promise<RuntimeCancelOutcome> {
    return this.executions.cancel(executionId, options);
  }

  /** Cancel all active executions (called during shutdown). */
  cancelAll(): void {
    this.executions.cancelAll();
  }

  async collectArtifacts(_executionId: string): Promise<ArtifactRef[]> {
    return [];
  }

  async healthcheck(): Promise<HealthStatus> {
    // Codex SDK reads auth from ~/.codex/config.toml or env vars,
    // so check if the config file exists or apiKey is explicitly provided
    try {
      const { existsSync } = await import('fs');
      const { join } = await import('path');
      const { homedir } = await import('os');
      const configExists = existsSync(join(homedir(), '.codex', 'config.toml'));
      const healthy = Boolean(this.config.apiKey) || configExists;
      return {
        healthy,
        name: 'codex',
        message: healthy ? 'Codex SDK configured' : 'No ~/.codex/config.toml or apiKey',
        lastCheckedAt: new Date(),
      };
    } catch {
      return {
        healthy: false,
        name: 'codex',
        message: 'Failed to check Codex configuration',
        lastCheckedAt: new Date(),
      };
    }
  }

  private async *runSDKTurn(
    prompt: string,
    cwd: string,
    artifactsDir: string,
    executionId: string,
    spec?: TaskSpec,
    resumeThreadId?: string,
    systemPromptAppend?: string,
    readOnly = false,
    runtimeEnv: Record<string, string> | undefined = undefined,
    imagePaths: string[] = [],
    model: string | undefined = this.config.model,
  ): AsyncGenerator<RuntimeEvent> {
    const abortController = new AbortController();
    this.executions.start(executionId, abortController);

    // Optional execution timeout (only if explicitly configured)
    const timeoutMs = this.config.timeoutMs;
    const idleTimeoutMs = this.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    let execTimedOut = false;
    const timeout = timeoutMs
      ? setTimeout(() => {
          execTimedOut = true;
          logger.warn({ executionId, timeoutMs }, 'Codex execution timed out, aborting');
          abortController.abort();
        }, timeoutMs)
      : null;
    let idleTimedOut = false;
    let startupTimedOut = false;
    let eventIterator: AsyncIterator<Record<string, unknown>> | null = null;

    // Resolve startupTimeoutMs before the try block so it is accessible in catch
    const rawStartupMs = parseInt(process.env.CODEX_STARTUP_TIMEOUT_MS ?? '120000', 10);
    const startupTimeoutMs =
      this.config.startupTimeoutMs ?? (Number.isNaN(rawStartupMs) ? 120_000 : rawStartupMs);

    try {
      yield { type: 'progress', percent: 10, message: 'Codex processing...' };

      const startTime = Date.now();

      const codex = new Codex({
        codexPathOverride: this.config.binaryPath,
        baseUrl: this.config.baseUrl,
        apiKey: this.config.apiKey,
        config: {
          // Codex SDK documents this config key in its exported types / README.
          // We force it off so local user config cannot surface raw reasoning to Feishu.
          show_raw_agent_reasoning: false,
        },
      });
      this.installTrackedCodexExec(codex, executionId, runtimeEnv);

      // Read-only turns are advisory now: they keep the non-mutating workflow
      // prompt but still allow inspection commands such as rg/git log/tests.
      // The worker still avoids creating a write worktree for readonly turns.
      if (readOnly) {
        logger.debug({ executionId, cwd }, 'Codex readonly workflow running with full sandbox');
      }
      const sandboxMode = 'danger-full-access' as const;
      const thread = resumeThreadId
        ? codex.resumeThread(resumeThreadId, {
            model,
            workingDirectory: cwd,
            sandboxMode,
            skipGitRepoCheck: true,
          })
        : codex.startThread({
            model,
            workingDirectory: cwd,
            sandboxMode,
            skipGitRepoCheck: true,
          });

      let startupTimer: ReturnType<typeof setTimeout> | null = null;
      if (startupTimeoutMs > 0) {
        startupTimer = setTimeout(() => {
          startupTimedOut = true;
          logger.warn({ executionId, startupTimeoutMs }, 'Codex startup timed out, aborting');
          abortController.abort();
        }, startupTimeoutMs);
      }

      let streamResult: Awaited<ReturnType<typeof thread.runStreamed>>;
      try {
        streamResult = await thread.runStreamed(
          this.buildRunInput(prompt, systemPromptAppend, imagePaths),
          {
            signal: abortController.signal,
          },
        );
      } finally {
        if (startupTimer) clearTimeout(startupTimer);
      }
      const { events } = streamResult;
      eventIterator = events[Symbol.asyncIterator]();

      // Consume the event stream, yielding progress updates
      let finalResponse = '';
      let usage: { input_tokens: number; output_tokens: number } | null = null;
      let commandCount = 0;
      let sessionEmitted = false;
      let streamCompleted = false;
      let runtimeStartedEmitted = false;
      const emittedReasoningSummaries = new Map<string, string>();

      while (!streamCompleted) {
        const next = await this.nextEventWithIdleTimeout(eventIterator, idleTimeoutMs, () => {
          idleTimedOut = true;
          logger.warn(
            { executionId, idleTimeoutMs },
            'Codex stream stalled without new events, aborting',
          );
          abortController.abort();
        });
        if (next.done) {
          break;
        }
        const event = next.value as any;
        if (!runtimeStartedEmitted) {
          runtimeStartedEmitted = true;
          yield { type: 'runtime_started', executionId };
        }
        // Emit thread ID as soon as we get it
        if (event.type === 'thread.started') {
          sessionEmitted = true;
          yield { type: 'session_created', sdkSessionId: event.thread_id };
        }

        const reasoningItem = extractReasoningItem(event);
        if (reasoningItem) {
          const previousSummary = emittedReasoningSummaries.get(reasoningItem.id);
          if (previousSummary !== reasoningItem.summary) {
            emittedReasoningSummaries.set(reasoningItem.id, reasoningItem.summary);
            yield { type: 'reasoning', summary: reasoningItem.summary };
          }
        }

        // Track progress from item events
        if (event.type === 'item.started') {
          const item = event.item;
          if (item.type === 'command_execution') {
            commandCount++;
            // Scale progress between 15-80% based on commands executed
            const percent = Math.min(15 + commandCount * 3, 80);
            const cmdPreview =
              item.command.length > 60 ? item.command.slice(0, 57) + '...' : item.command;
            yield { type: 'progress', percent, message: `Running: ${cmdPreview}` };
          } else if (item.type === 'file_change') {
            yield {
              type: 'progress',
              percent: Math.min(15 + commandCount * 3, 80),
              message: 'Applying file changes...',
            };
          }
        }

        // Capture the final agent message
        if (event.type === 'item.completed' && event.item.type === 'agent_message') {
          finalResponse = event.item.text;
        }

        // Capture usage from turn completion
        if (event.type === 'turn.completed') {
          usage = event.usage;
          // Some SDK sessions keep the stream open after the turn is complete.
          // Exit immediately so the worker can persist results instead of waiting
          // for pg-boss active-state timeout.
          streamCompleted = true;
          break;
        }

        // Handle turn failure
        if (event.type === 'turn.failed') {
          throw new Error(event.error.message);
        }
      }

      const durationMs = Date.now() - startTime;
      const threadId = thread.id;

      yield { type: 'progress', percent: 90, message: 'Collecting results...' };

      // Emit session_created if not already emitted via thread.started event
      if (threadId && !sessionEmitted) {
        yield { type: 'session_created', sdkSessionId: threadId };
      }

      // Collect artifacts from the canonical scratch artifacts dir (NOT
      // `cwd/artifacts`): aligns these events with the worker/daemon persistence
      // scan and honors the scratch-only invariant (handle.artifactsDir).
      const artifacts = await collectArtifactsFromDir(artifactsDir);
      for (const art of artifacts) {
        yield { type: 'artifact', ref: art };
      }

      const taskResult: TaskResult = {
        taskId: spec?.taskId ?? executionId,
        status: 'completed',
        output: { text: finalResponse },
        metrics: {
          durationMs,
          tokenIn: usage?.input_tokens ?? 0,
          tokenOut: usage?.output_tokens ?? 0,
          estimatedCostUsd: 0,
        },
      };
      yield { type: 'completed', result: taskResult };
    } catch (err) {
      const message = errorMessage(err);
      // Classification comes from the explicit timer flags, never from the
      // error text — child-kill messages vary by path (AbortError, SIGTERM).
      const isTimeout = execTimedOut && !idleTimedOut && !startupTimedOut;
      if (startupTimedOut) {
        const msg = `Codex startup timed out after ${this.formatDuration(startupTimeoutMs)}`;
        yield { type: 'failed', error: msg };
        return;
      }
      if (abortController.signal.aborted && !idleTimedOut && !isTimeout && !execTimedOut) {
        yield { type: 'failed', error: message || 'Cancelled', reason: 'cancelled' };
        return;
      }
      yield {
        type: 'failed',
        error: idleTimedOut
          ? `Codex stream stalled after ${this.formatDuration(idleTimeoutMs)} without new events`
          : isTimeout
            ? `Codex execution timed out after ${this.formatDuration(timeoutMs ?? 0)}`
            : message,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      // Drive the underlying generator's cleanup (which kills the child) and
      // wait for it — bounded — BEFORE releasing the registry entry, so the
      // codex process cannot outlive its execution's settlement.
      if (eventIterator && typeof eventIterator.return === 'function') {
        try {
          await Promise.race([
            Promise.resolve(eventIterator.return()).catch(() => undefined),
            new Promise((resolve) => {
              const timer = setTimeout(resolve, ITERATOR_CLEANUP_TIMEOUT_MS);
              timer.unref?.();
            }),
          ]);
        } catch {
          // Ignore iterator cleanup errors during shutdown/abort.
        }
      }
      this.executions.complete(executionId);
    }
  }

  private async nextEventWithIdleTimeout<T>(
    iterator: AsyncIterator<T>,
    idleTimeoutMs: number,
    onTimeout: () => void,
  ): Promise<IteratorResult<T>> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<T>>((_, reject) => {
          timer = setTimeout(() => {
            onTimeout();
            reject(
              new Error(
                `Codex stream stalled after ${this.formatDuration(idleTimeoutMs)} without new events`,
              ),
            );
          }, idleTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
    return `${Math.max(1, Math.round(ms / 60_000))} minutes`;
  }

  private buildPrompt(prompt: string, systemPromptAppend?: string): string {
    if (!systemPromptAppend) return prompt;
    return this.isStructuredPrompt(prompt)
      ? `${systemPromptAppend}\n\n${prompt}`
      : `${systemPromptAppend}\n\n<current_request>\n${prompt}\n</current_request>`;
  }

  private buildRunInput(
    prompt: string,
    systemPromptAppend?: string,
    imagePaths: string[] = [],
  ): CodexRunInput {
    const text = this.buildPrompt(prompt, systemPromptAppend);
    if (imagePaths.length === 0) return text;
    return [
      { type: 'text', text },
      ...imagePaths.map((path) => ({ type: 'local_image' as const, path })),
    ];
  }

  private installTrackedCodexExec(
    codex: Codex,
    executionId: string,
    runtimeEnv?: Record<string, string>,
  ): void {
    const mutableCodex = codex as unknown as {
      exec?: {
        executablePath?: string;
        envOverride?: Record<string, string>;
        configOverrides?: Record<string, unknown>;
        // `pathDirs` was added in @openai/codex-sdk 0.137: when the SDK resolves
        // its OWN bundled binary (no codexPathOverride), it prepends the vendor's
        // `codex-path` dir (bundled `rg`, resources) to PATH at spawn time. Our
        // TrackedCodexExec fully replaces `run()`, so it MUST carry these dirs
        // forward or SDK-default codex runs lose their bundled tools.
        pathDirs?: string[];
      };
    };
    const originalExec = mutableCodex.exec;
    if (!originalExec?.executablePath) {
      return;
    }

    mutableCodex.exec = new TrackedCodexExec({
      executablePath: originalExec.executablePath,
      envOverride: originalExec.envOverride,
      configOverrides: originalExec.configOverrides,
      pathDirs: originalExec.pathDirs ?? [],
      runtimeEnv,
      executionId,
      executions: this.executions,
    }) as unknown as typeof originalExec;
  }

  private isStructuredPrompt(prompt: string): boolean {
    return (
      prompt.includes('<current_request>') ||
      prompt.includes('<conversation_history>') ||
      prompt.includes('<session_memory>')
    );
  }

}

interface CodexExecRunArgs {
  input: string;
  baseUrl?: string;
  apiKey?: string;
  threadId?: string | null;
  images?: string[];
  model?: string;
  sandboxMode?: string;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  outputSchemaFile?: string;
  modelReasoningEffort?: string;
  signal?: AbortSignal;
  networkAccessEnabled?: boolean;
  webSearchMode?: string;
  webSearchEnabled?: boolean;
  approvalPolicy?: string;
  additionalDirectories?: string[];
}

export class TrackedCodexExec {
  constructor(
    private readonly options: {
      executablePath: string;
      envOverride?: Record<string, string>;
      configOverrides?: Record<string, unknown>;
      /** Vendor PATH dirs the SDK would prepend (0.137+); empty when a binaryPath override is set. */
      pathDirs?: string[];
      /** Per-task environment variables injected from agent runtime config. */
      runtimeEnv?: Record<string, string>;
      executionId: string;
      executions: RuntimeExecutionRegistry;
    },
  ) {}

  async *run(args: CodexExecRunArgs): AsyncGenerator<string> {
    const commandArgs = this.buildCommandArgs(args);
    const env = this.buildEnv(args);
    const child = spawn(this.options.executablePath, commandArgs, {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      // Restores the SDK original's abort wiring: without this, every
      // timeout layer in the adapter aborts a signal nobody listens to and
      // the codex process keeps running after the task is settled.
      signal: args.signal,
    });
    this.options.executions.attachChild(this.options.executionId, child);

    let spawnError: Error | null = null;
    child.once('error', (err) => {
      spawnError = err;
    });
    if (!child.stdin) {
      child.kill();
      throw new Error('Child process has no stdin');
    }
    // Guard the write: a child that fails to spawn or exits without reading
    // stdin emits EPIPE on this stream; unhandled it becomes an uncaught
    // exception (an upstream SDK bug we do not inherit).
    child.stdin.on('error', (err) => {
      logger.warn(
        { executionId: this.options.executionId, err },
        'Codex stdin write failed; child exited before consuming input',
      );
    });
    child.stdin.write(args.input);
    child.stdin.end();
    if (!child.stdout) {
      this.killChildTree(child);
      throw new Error('Child process has no stdout');
    }

    // The spawn `signal` option only signals the DIRECT child; codex spawns
    // descendants (shell commands) into the detached process group, so abort
    // must also sweep the group or those descendants outlive the task.
    const onAbort = () => this.killChildTree(child);
    args.signal?.addEventListener('abort', onAbort, { once: true });

    const stderrChunks: Buffer[] = [];
    child.stderr?.on('data', (data) => {
      stderrChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
    });
    // Settle on exit OR close OR error: Node may never emit `exit` after a
    // spawn failure, and awaiting it alone would hang this generator forever.
    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        const settle = (code: number | null, signal: NodeJS.Signals | null) => {
          resolve({ code, signal });
        };
        child.once('exit', settle);
        child.once('close', settle);
        child.once('error', () => resolve({ code: child.exitCode, signal: child.signalCode }));
      },
    );
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        yield line;
      }
      if (spawnError) throw spawnError;
      const { code, signal } = await exitPromise;
      if (spawnError) throw spawnError;
      if (code !== 0 || signal) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        throw new Error(
          `Codex Exec exited with ${detail}: ${Buffer.concat(stderrChunks).toString('utf8')}`,
        );
      }
    } finally {
      rl.close();
      args.signal?.removeEventListener('abort', onAbort);
      // SDK-original cleanup: an early generator return (consumer break) or a
      // thrown error must not orphan the child — and on POSIX the kill must
      // target the detached process group, not just the direct child. Unlike
      // the SDK we keep the child's listeners — the execution registry's exit
      // hook must survive.
      this.killChildTree(child);
    }
  }

  /**
   * Best-effort SIGTERM for the child's detached process group (falls back to
   * the direct child). No-op once the child has actually exited. The registry
   * owns SIGKILL escalation for explicit cancels.
   */
  private killChildTree(child: ReturnType<typeof spawn>, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Group may already be gone or not detached; fall through.
      }
    }
    try {
      child.kill(signal);
    } catch {
      // best-effort
    }
  }

  private buildCommandArgs(args: CodexExecRunArgs): string[] {
    const commandArgs = ['exec', '--experimental-json'];
    if (this.options.configOverrides) {
      for (const override of serializeConfigOverrides(this.options.configOverrides)) {
        commandArgs.push('--config', override);
      }
    }
    if (args.baseUrl) {
      commandArgs.push('--config', `openai_base_url=${toTomlValue(args.baseUrl)}`);
    }
    if (args.model) commandArgs.push('--model', args.model);
    if (args.sandboxMode) commandArgs.push('--sandbox', args.sandboxMode);
    if (args.workingDirectory) commandArgs.push('--cd', args.workingDirectory);
    for (const dir of args.additionalDirectories ?? []) {
      commandArgs.push('--add-dir', dir);
    }
    if (args.skipGitRepoCheck) commandArgs.push('--skip-git-repo-check');
    if (args.outputSchemaFile) commandArgs.push('--output-schema', args.outputSchemaFile);
    if (args.modelReasoningEffort) {
      commandArgs.push(
        '--config',
        `model_reasoning_effort=${toTomlValue(args.modelReasoningEffort)}`,
      );
    }
    if (args.networkAccessEnabled !== undefined) {
      commandArgs.push(
        '--config',
        `sandbox_workspace_write.network_access=${args.networkAccessEnabled}`,
      );
    }
    if (args.webSearchMode) {
      commandArgs.push('--config', `web_search=${toTomlValue(args.webSearchMode)}`);
    } else if (args.webSearchEnabled === true) {
      commandArgs.push('--config', 'web_search="live"');
    } else if (args.webSearchEnabled === false) {
      commandArgs.push('--config', 'web_search="disabled"');
    }
    if (args.approvalPolicy) {
      commandArgs.push('--config', `approval_policy=${toTomlValue(args.approvalPolicy)}`);
    }
    if (args.threadId) {
      commandArgs.push('resume', args.threadId);
    }
    for (const image of args.images ?? []) {
      commandArgs.push('--image', image);
    }
    return commandArgs;
  }

  private buildEnv(args: CodexExecRunArgs): Record<string, string> {
    return buildCodexExecEnv({
      envOverride: this.options.envOverride,
      runtimeEnv: this.options.runtimeEnv,
      apiKey: args.apiKey,
      pathDirs: this.options.pathDirs,
    });
  }
}

export function buildCodexExecEnv(input: {
  baseEnv?: NodeJS.ProcessEnv;
  envOverride?: Record<string, string>;
  runtimeEnv?: Record<string, string>;
  apiKey?: string;
  pathDirs?: string[];
  platform?: NodeJS.Platform;
}): Record<string, string> {
  const env: Record<string, string> = {};
  if (input.envOverride) {
    Object.assign(env, input.envOverride);
  } else {
    for (const [key, value] of Object.entries(input.baseEnv ?? process.env)) {
      if (value !== undefined) env[key] = value;
    }
  }
  Object.assign(env, input.runtimeEnv ?? {});
  if (!env[INTERNAL_ORIGINATOR_ENV]) {
    env[INTERNAL_ORIGINATOR_ENV] = TYPESCRIPT_SDK_ORIGINATOR;
  }
  if (input.apiKey) {
    env.CODEX_API_KEY = input.apiKey;
  }
  // Mirror @openai/codex-sdk's `prependPathDirs`: when the SDK runs its own
  // bundled binary it puts the vendor `codex-path` dir (bundled `rg`, etc.)
  // first on PATH. We replace the SDK's exec, so we must replicate it or those
  // tools vanish for SDK-default (no-override) codex runs.
  if (input.pathDirs && input.pathDirs.length > 0) {
    prependPathDirs(env, input.pathDirs, input.platform);
  }
  return env;
}

/**
 * Prepends `pathDirs` to the PATH env var, de-duplicating, mirroring
 * `@openai/codex-sdk`'s internal helper of the same name. POSIX uses `PATH`;
 * Windows resolves the actual casing among `path`-like keys and collapses them.
 *
 * Exported for focused unit tests (the regression this guards — SDK-default
 * codex losing its bundled vendor PATH after the 0.137 upgrade — is otherwise
 * only reachable through a full adapter spawn).
 */
export function prependPathDirs(
  env: Record<string, string>,
  pathDirs: string[],
  platform: NodeJS.Platform = process.platform,
): void {
  const pathKey = resolvePathEnvKey(env, platform);
  if (platform === 'win32') {
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path' && key !== pathKey) delete env[key];
    }
  }
  const existing = (env[pathKey] ?? '')
    .split(pathDelimiter)
    .filter((entry) => entry.length > 0 && !pathDirs.includes(entry));
  env[pathKey] = [...pathDirs, ...existing].join(pathDelimiter);
}

function resolvePathEnvKey(env: Record<string, string>, platform: NodeJS.Platform): string {
  if (platform !== 'win32') return 'PATH';
  const matching = Object.keys(env).filter((key) => key.toLowerCase() === 'path');
  return matching.includes('Path') ? 'Path' : (matching.at(-1) ?? 'PATH');
}

function serializeConfigOverrides(configOverrides: Record<string, unknown>): string[] {
  const overrides: string[] = [];
  flattenConfigOverrides(configOverrides, '', overrides);
  return overrides;
}

function flattenConfigOverrides(value: unknown, prefix: string, overrides: string[]): void {
  if (!isPlainObject(value)) {
    if (prefix) overrides.push(`${prefix}=${toTomlValue(value)}`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    const path = prefix ? `${prefix}.${formatTomlKey(key)}` : formatTomlKey(key);
    flattenConfigOverrides(child, path, overrides);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatTomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function toTomlValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.map(toTomlValue).join(', ')}]`;
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => `${formatTomlKey(key)} = ${toTomlValue(child)}`);
    return `{ ${entries.join(', ')} }`;
  }
  return JSON.stringify(value);
}

function extractReasoningItem(
  event: Record<string, unknown>,
): { id: string; summary: string } | null {
  if (
    event.type !== 'item.started' &&
    event.type !== 'item.updated' &&
    event.type !== 'item.completed'
  ) {
    return null;
  }

  const item = event.item;
  if (!item || typeof item !== 'object') {
    return null;
  }

  if (!('type' in item) || item.type !== 'reasoning') {
    return null;
  }

  if (!('id' in item) || typeof item.id !== 'string') {
    return null;
  }

  if (!('text' in item) || typeof item.text !== 'string') {
    return null;
  }

  const normalized = item.text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }

  const summary =
    normalized.length > MAX_REASONING_SUMMARY_LENGTH
      ? `${normalized.slice(0, MAX_REASONING_SUMMARY_LENGTH - 3)}...`
      : normalized;

  return {
    id: item.id,
    summary,
  };
}
