import { spawn } from 'child_process';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import readline from 'readline';
import { createLogger } from '@open-tag/observability';
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

const logger = createLogger('coco-adapter');

/**
 * Open capability descriptor for the Coco (TRAE CLI) runtime. Coco always runs
 * `--yolo` (full access, no prompts) and authenticates from local git
 * credentials, so it carries no credential env vars.
 */
export const COCO_DESCRIPTOR: RuntimeDescriptor = {
  id: 'coco',
  displayName: 'Coco',
  capabilities: {
    // `coco --resume <session>` resumes a prior session.
    resume: true,
    // `--yolo` runs unrestricted; there is no read-only enforcement.
    enforcesReadOnly: false,
    // `--yolo` is headless with no interactive approval.
    interactivePermission: false,
    sandboxModes: ['danger-full-access'],
    // Coco recognises an image from its path embedded in the prompt text.
    imageInput: 'local-path',
    modelSelection: true,
  },
  // Coco authenticates via the host's local git credentials; no credential env.
  credentialEnv: [],
  workflowPrompts: { selfDev: 'self-dev-coco', readonly: 'readonly', default: 'general-task' },
};

/**
 * Coco (TRAE CLI / Codebase Copilot) runtime adapter.
 *
 * Coco ships NO programmable SDK — it is a standalone CLI authenticated via the
 * local git credentials. We run it headless:
 *   `coco --print --output-format=stream-json --include-partial-messages --yolo "<prompt>"`
 * and parse its Claude-Code-style stream-json line protocol into RuntimeEvents.
 *
 * The process-group lifecycle (detached spawn, group SIGTERM→SIGKILL, idle and
 * startup timeouts, EPIPE-safe streams) mirrors `CodexAdapter`'s TrackedCodexExec
 * so cancellation and shutdown behave identically across runtimes.
 */

const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const ITERATOR_CLEANUP_TIMEOUT_MS = 2_000;
const MAX_REASONING_SUMMARY_LENGTH = 500;
/** Emit a reasoning update only after this many new chars accumulate. */
const REASONING_FLUSH_THRESHOLD = 120;

export interface CocoConfig {
  /** Resolved absolute path to the `coco` binary. Falls back to the `coco` command on PATH. */
  binaryPath?: string;
  /** Model name passed via `-c model.name=<model>`. Omitted when unset (Coco uses its host default). */
  model?: string;
  /** Optional hard execution timeout in milliseconds. No timeout by default. */
  timeoutMs?: number;
  /** Optional idle timeout between streamed events. Defaults to 15 minutes. */
  idleTimeoutMs?: number;
  /**
   * Max ms to wait for Coco to emit its first streamed line before aborting.
   * Default: COCO_STARTUP_TIMEOUT_MS env or 120_000 (2 min). 0 disables.
   */
  startupTimeoutMs?: number;
  cancelSigtermGraceMs?: number;
  cancelSigkillGraceMs?: number;
  /** Optional image downloader for handling image attachments in tasks. */
  imageDownloader?: ImageDownloader;
  /** Extra config overrides appended as `-c <k=v>` (repeatable). */
  configOverrides?: string[];
  /** Test seam: spawn implementation (defaults to child_process.spawn). */
  spawnImpl?: typeof spawn;
}

interface CocoUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface CocoStreamState {
  taskId: string;
  executionId: string;
  startTime: number;
  runtimeStartedEmitted: boolean;
  sessionEmitted: boolean;
  toolCount: number;
  titleEmitted: boolean;
  reasoningBuffer: string;
  reasoningEmittedLen: number;
  lastReasoningSummary: string;
  textBuffer: string;
  finalText?: string;
  usage?: CocoUsage;
  terminal: boolean;
}

export function createCocoStreamState(ctx: {
  taskId: string;
  executionId: string;
  startTime: number;
}): CocoStreamState {
  return {
    taskId: ctx.taskId,
    executionId: ctx.executionId,
    startTime: ctx.startTime,
    runtimeStartedEmitted: false,
    sessionEmitted: false,
    toolCount: 0,
    titleEmitted: false,
    reasoningBuffer: '',
    reasoningEmittedLen: 0,
    lastReasoningSummary: '',
    textBuffer: '',
    terminal: false,
  };
}

/** Builds the argv for a `coco` headless streaming run. The prompt is the final positional arg. */
export function buildCocoArgs(opts: {
  prompt: string;
  model?: string;
  resumeSessionId?: string;
  addDirs?: string[];
  configOverrides?: string[];
}): string[] {
  const args = [
    '--print',
    '--output-format=stream-json',
    '--include-partial-messages',
    '--yolo',
  ];
  if (opts.model) {
    args.push('-c', `model.name=${opts.model}`);
  }
  for (const override of opts.configOverrides ?? []) {
    args.push('-c', override);
  }
  for (const dir of opts.addDirs ?? []) {
    args.push('--add-dir', dir);
  }
  if (opts.resumeSessionId) {
    args.push('--resume', opts.resumeSessionId);
  }
  // Prompt is the documented positional `[prompt]`; Coco does NOT read it from
  // stdin (verified: piped stdin yields a non-zero exit with no output).
  args.push(opts.prompt);
  return args;
}

function capReasoning(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= MAX_REASONING_SUMMARY_LENGTH) return normalized;
  // Keep the most recent thinking (tail), prefixed to show truncation.
  return `...${normalized.slice(normalized.length - (MAX_REASONING_SUMMARY_LENGTH - 3))}`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * Maps a single parsed Coco stream-json event onto zero or more RuntimeEvents,
 * mutating `state`. Pure of I/O — replay fixtures through it in tests.
 */
export function processCocoEvent(
  event: Record<string, unknown>,
  state: CocoStreamState,
): RuntimeEvent[] {
  const out: RuntimeEvent[] = [];
  const type = event.type;

  if (!state.runtimeStartedEmitted) {
    state.runtimeStartedEmitted = true;
    out.push({ type: 'runtime_started', executionId: state.executionId });
  }

  if (type === 'system') {
    const subtype = event.subtype;
    if (subtype === 'init') {
      const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined;
      if (sessionId && !state.sessionEmitted) {
        state.sessionEmitted = true;
        out.push({ type: 'session_created', sdkSessionId: sessionId });
      }
      out.push({ type: 'progress', percent: 12, message: 'Coco initialized' });
    } else if (subtype === 'status') {
      const updates = asRecord(event.updates);
      const title = updates && typeof updates.title === 'string' ? updates.title : undefined;
      if (title && !state.titleEmitted) {
        state.titleEmitted = true;
        const preview = title.length > 60 ? `${title.slice(0, 57)}...` : title;
        out.push({ type: 'progress', percent: 15, message: `Coco: ${preview}` });
      }
    }
    return out;
  }

  if (type === 'user') {
    // A completed tool call comes back as a tool_result user turn. Use it as the
    // progress heartbeat (mirrors codex's command-count scaling, capped at 80%).
    if (event.subtype === 'tool_result') {
      state.toolCount += 1;
      const percent = Math.min(15 + state.toolCount * 3, 80);
      out.push({ type: 'progress', percent, message: `Coco running (${state.toolCount} tool calls)...` });
    }
    return out;
  }

  if (type === 'stream_event') {
    const delta = asRecord(event.delta);
    if (!delta) return out;
    if (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) {
      state.reasoningBuffer += delta.reasoning_content;
      if (state.reasoningBuffer.length - state.reasoningEmittedLen >= REASONING_FLUSH_THRESHOLD) {
        const summary = capReasoning(state.reasoningBuffer);
        state.reasoningEmittedLen = state.reasoningBuffer.length;
        if (summary && summary !== state.lastReasoningSummary) {
          state.lastReasoningSummary = summary;
          out.push({ type: 'reasoning', summary });
        }
      }
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      state.textBuffer += delta.content;
    }
    const meta = asRecord(delta.response_meta);
    const usage = meta && asRecord(meta.usage);
    if (usage) {
      state.usage = normalizeUsage(usage);
    }
    return out;
  }

  if (type === 'assistant') {
    const message = asRecord(event.message);
    if (message) {
      if (typeof message.content === 'string' && message.content.trim().length > 0) {
        state.finalText = message.content;
      }
      // Flush any reasoning the throttle has not yet surfaced.
      if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) {
        state.reasoningBuffer = message.reasoning_content;
        const summary = capReasoning(state.reasoningBuffer);
        if (summary && summary !== state.lastReasoningSummary) {
          state.reasoningEmittedLen = state.reasoningBuffer.length;
          state.lastReasoningSummary = summary;
          out.push({ type: 'reasoning', summary });
        }
      }
      const meta = asRecord(message.response_meta);
      const usage = meta && asRecord(meta.usage);
      if (usage) state.usage = normalizeUsage(usage);
    }
    return out;
  }

  if (type === 'result') {
    state.terminal = true;
    const isError = event.is_error === true || event.subtype !== 'success';
    if (isError) {
      const reason =
        (typeof event.error === 'string' && event.error) ||
        (typeof event.result === 'string' && event.result) ||
        `Coco run failed (${String(event.subtype ?? 'unknown')})`;
      out.push({ type: 'failed', error: reason });
      return out;
    }
    const usage = asRecord(event.usage);
    if (usage) state.usage = normalizeUsage(usage);
    const finalText =
      (typeof event.result === 'string' && event.result) ||
      state.finalText ||
      state.textBuffer ||
      '';
    const durationMs =
      typeof event.duration_ms === 'number' ? event.duration_ms : Date.now() - state.startTime;
    out.push({ type: 'progress', percent: 90, message: 'Collecting results...' });
    out.push(buildCompleted(state, finalText, durationMs));
    return out;
  }

  return out;
}

function normalizeUsage(usage: Record<string, unknown>): CocoUsage {
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  return {
    input_tokens: num(usage.input_tokens) ?? num(usage.prompt_tokens),
    output_tokens: num(usage.output_tokens) ?? num(usage.completion_tokens),
    cache_read_input_tokens: num(usage.cache_read_input_tokens),
  };
}

function buildCompleted(
  state: CocoStreamState,
  finalText: string,
  durationMs: number,
): RuntimeEvent {
  const result: TaskResult = {
    taskId: state.taskId,
    status: 'completed',
    output: { text: finalText },
    metrics: {
      durationMs,
      tokenIn: state.usage?.input_tokens ?? 0,
      tokenOut: state.usage?.output_tokens ?? 0,
      estimatedCostUsd: 0,
    },
  };
  return { type: 'completed', result };
}

export class CocoAdapter implements RuntimeAdapter {
  private readonly config: CocoConfig;
  private readonly executions: RuntimeExecutionRegistry;
  private readonly spawnImpl: typeof spawn;

  constructor(config: CocoConfig = {}) {
    this.config = config;
    this.spawnImpl = config.spawnImpl ?? spawn;
    this.executions = new RuntimeExecutionRegistry({
      runtimeName: 'coco',
      sigtermGraceMs: config.cancelSigtermGraceMs,
      sigkillGraceMs: config.cancelSigkillGraceMs,
      logger,
    });
  }

  name(): string {
    return 'coco';
  }

  descriptor(): RuntimeDescriptor {
    return COCO_DESCRIPTOR;
  }

  async prepare(spec: TaskSpec, workspace: WorkspaceContext): Promise<RuntimeHandle> {
    const taskMdPath = join(workspace.workspacePath, 'TASK.md');
    await writeFile(
      taskMdPath,
      `# Task: ${spec.goal}\n\nType: ${spec.taskType}\nSession: ${spec.sessionId}\n`,
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
    yield { type: 'status', message: 'Starting Coco...' };
    yield* this.runTurn({
      prompt: spec.goal,
      cwd: handle.cwd,
      executionId: handle.executionId,
      taskId: spec.taskId,
      // Per-task model (from the agent profile) wins over the adapter default.
      model: spec.model ?? this.config.model,
      systemPromptAppend,
      runtimeEnv: handle.runtimeEnv,
      imagePaths: handle.imagePaths ?? [],
    });
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
    yield { type: 'status', message: 'Resuming Coco session...' };
    // Generate the synthetic fallback id once: when both executionId and taskId
    // are absent, two separate `Date.now()` calls could differ by a tick and
    // desync executionId from taskId, breaking execution registration/cancel and
    // event correlation.
    const fallbackId = `resume-${Date.now()}`;
    yield* this.runTurn({
      prompt,
      cwd: workspace.cwd ?? workspace.workspacePath,
      executionId: options.executionId ?? options.taskId ?? fallbackId,
      taskId: options.taskId ?? options.executionId ?? fallbackId,
      resumeSessionId: sdkSessionId,
      model: options.model ?? this.config.model,
      systemPromptAppend,
      runtimeEnv: workspace.runtimeEnv,
      imagePaths: options.imagePaths ?? [],
    });
  }

  async cancel(
    executionId: string,
    options: RuntimeCancelOptions = {},
  ): Promise<RuntimeCancelOutcome> {
    return this.executions.cancel(executionId, options);
  }

  cancelAll(): void {
    this.executions.cancelAll();
  }

  async collectArtifacts(_executionId: string): Promise<ArtifactRef[]> {
    return [];
  }

  async healthcheck(): Promise<HealthStatus> {
    const binaryPath = this.config.binaryPath;
    try {
      if (binaryPath && (binaryPath.includes('/') || binaryPath.includes('\\'))) {
        const { existsSync } = await import('fs');
        const healthy = existsSync(binaryPath);
        return {
          healthy,
          name: 'coco',
          message: healthy ? `Coco CLI at ${binaryPath}` : `Coco binary not found at ${binaryPath}`,
          lastCheckedAt: new Date(),
        };
      }
      // No absolute path: rely on the `coco` command being on PATH at spawn.
      return {
        healthy: true,
        name: 'coco',
        message: 'Coco CLI resolved from PATH',
        lastCheckedAt: new Date(),
      };
    } catch {
      return {
        healthy: false,
        name: 'coco',
        message: 'Failed to check Coco configuration',
        lastCheckedAt: new Date(),
      };
    }
  }

  private buildPrompt(prompt: string, systemPromptAppend?: string, imagePaths: string[] = []): string {
    let body = prompt;
    if (imagePaths.length > 0) {
      // Coco recognises an image by its path embedded in the prompt text.
      body = `${prompt}\n\n${imagePaths.map((p) => `Image: ${p}`).join('\n')}`;
    }
    if (!systemPromptAppend) return body;
    return this.isStructuredPrompt(body)
      ? `${systemPromptAppend}\n\n${body}`
      : `${systemPromptAppend}\n\n<current_request>\n${body}\n</current_request>`;
  }

  private isStructuredPrompt(prompt: string): boolean {
    return (
      prompt.includes('<current_request>') ||
      prompt.includes('<conversation_history>') ||
      prompt.includes('<session_memory>')
    );
  }

  private async *runTurn(opts: {
    prompt: string;
    cwd: string;
    executionId: string;
    taskId: string;
    resumeSessionId?: string;
    model?: string;
    systemPromptAppend?: string;
    runtimeEnv?: Record<string, string>;
    imagePaths: string[];
  }): AsyncGenerator<RuntimeEvent> {
    const { executionId } = opts;
    const abortController = new AbortController();
    this.executions.start(executionId, abortController);

    const timeoutMs = this.config.timeoutMs;
    const idleTimeoutMs = this.config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const rawStartupMs = parseInt(process.env.COCO_STARTUP_TIMEOUT_MS ?? '120000', 10);
    const startupTimeoutMs =
      this.config.startupTimeoutMs ?? (Number.isNaN(rawStartupMs) ? 120_000 : rawStartupMs);

    let execTimedOut = false;
    let idleTimedOut = false;
    let startupTimedOut = false;
    const timeout = timeoutMs
      ? setTimeout(() => {
          execTimedOut = true;
          logger.warn({ executionId, timeoutMs }, 'Coco execution timed out, aborting');
          abortController.abort();
        }, timeoutMs)
      : null;

    const binary = this.config.binaryPath ?? 'coco';
    const prompt = this.buildPrompt(opts.prompt, opts.systemPromptAppend, opts.imagePaths);
    const args = buildCocoArgs({
      prompt,
      model: opts.model ?? this.config.model,
      resumeSessionId: opts.resumeSessionId,
      configOverrides: this.config.configOverrides,
    });

    const env: NodeJS.ProcessEnv = { ...process.env, ...(opts.runtimeEnv ?? {}) };

    let rl: readline.Interface | null = null;
    let child: ReturnType<typeof spawn> | null = null;
    const state = createCocoStreamState({
      taskId: opts.taskId,
      executionId,
      startTime: Date.now(),
    });

    try {
      yield { type: 'progress', percent: 10, message: 'Coco processing...' };

      child = this.spawnImpl(binary, args, {
        cwd: opts.cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        signal: abortController.signal,
      });
      this.executions.attachChild(executionId, child);

      let spawnError: Error | null = null;
      child.once('error', (err) => {
        spawnError = err;
      });

      const stderrChunks: Buffer[] = [];
      child.stderr?.on('data', (data) => {
        stderrChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(String(data)));
      });

      const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => {
          const settle = (code: number | null, signal: NodeJS.Signals | null) =>
            resolve({ code, signal });
          child!.once('exit', settle);
          child!.once('close', settle);
          child!.once('error', () => resolve({ code: child!.exitCode, signal: child!.signalCode }));
        },
      );

      if (!child.stdout) {
        this.killChildTree(child);
        throw new Error('Coco child process has no stdout');
      }

      // Abort sweeps the detached process group and closes the reader so the
      // line loop terminates promptly.
      const onAbort = () => {
        this.killChildTree(child!);
        rl?.close();
      };
      abortController.signal.addEventListener('abort', onAbort, { once: true });

      let startupTimer: ReturnType<typeof setTimeout> | null = null;
      if (startupTimeoutMs > 0) {
        startupTimer = setTimeout(() => {
          startupTimedOut = true;
          logger.warn({ executionId, startupTimeoutMs }, 'Coco startup timed out, aborting');
          abortController.abort();
        }, startupTimeoutMs);
      }

      rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
      const lineIterator = rl[Symbol.asyncIterator]();

      try {
        while (!state.terminal) {
          const next = await this.nextLineWithIdleTimeout(lineIterator, idleTimeoutMs, () => {
            idleTimedOut = true;
            logger.warn({ executionId, idleTimeoutMs }, 'Coco stream stalled, aborting');
            abortController.abort();
          });
          if (next.done) break;
          const line = next.value.trim();
          if (!line) continue;
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(line) as Record<string, unknown>;
          } catch {
            logger.debug({ executionId, line: line.slice(0, 200) }, 'Skipping non-JSON Coco line');
            continue;
          }
          // Clear startup protection only once a VALID stream event arrives — a
          // banner/warning line before the first JSON must not disable it.
          if (startupTimer) {
            clearTimeout(startupTimer);
            startupTimer = null;
          }
          for (const ev of processCocoEvent(parsed, state)) {
            yield ev;
          }
        }
      } finally {
        if (startupTimer) clearTimeout(startupTimer);
        abortController.signal.removeEventListener('abort', onAbort);
      }

      if (spawnError) throw spawnError;

      // Emit the trailing artifacts (parity with codex) before finalizing.
      if (state.terminal) {
        const artifacts = await collectArtifactsFromDir(join(opts.cwd, 'artifacts'));
        for (const art of artifacts) {
          yield { type: 'artifact', ref: art };
        }
        return;
      }

      // Stream ended without a `result` line — settle from the exit status.
      const { code, signal } = await exitPromise;
      if (abortController.signal.aborted) {
        throw new Error('aborted');
      }
      if (code !== 0 || signal) {
        const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        throw new Error(`Coco exited with ${detail}${stderr ? `: ${stderr}` : ''}`);
      }
      if (state.finalText || state.textBuffer) {
        yield buildCompleted(state, state.finalText ?? state.textBuffer, Date.now() - state.startTime);
      } else {
        yield { type: 'failed', error: 'Coco stream ended without a result' };
      }
    } catch (err) {
      const message = errorMessage(err);
      const isExecTimeout = execTimedOut && !idleTimedOut && !startupTimedOut;
      if (startupTimedOut) {
        yield { type: 'failed', error: `Coco startup timed out after ${this.formatDuration(startupTimeoutMs)}` };
        return;
      }
      if (idleTimedOut) {
        yield {
          type: 'failed',
          error: `Coco stream stalled after ${this.formatDuration(idleTimeoutMs)} without new events`,
        };
        return;
      }
      if (isExecTimeout) {
        yield { type: 'failed', error: `Coco execution timed out after ${this.formatDuration(timeoutMs ?? 0)}` };
        return;
      }
      if (abortController.signal.aborted) {
        yield { type: 'failed', error: message || 'Cancelled', reason: 'cancelled' };
        return;
      }
      yield { type: 'failed', error: message };
    } finally {
      if (timeout) clearTimeout(timeout);
      if (rl) {
        try {
          rl.close();
        } catch {
          // ignore
        }
      }
      if (child) {
        this.killChildTree(child, 'SIGTERM');
        // Bounded wait so the child cannot outlive settlement.
        await Promise.race([
          new Promise<void>((resolve) => {
            if (child!.exitCode !== null || child!.signalCode !== null) return resolve();
            child!.once('exit', () => resolve());
            child!.once('close', () => resolve());
          }),
          new Promise<void>((resolve) => {
            const t = setTimeout(resolve, ITERATOR_CLEANUP_TIMEOUT_MS);
            t.unref?.();
          }),
        ]);
        // Escalate: a SIGTERM-resistant detached group must not outlive the task
        // (timeouts don't go through the registry's cancel-escalation path).
        if (child.exitCode === null && child.signalCode === null) {
          this.killChildTree(child, 'SIGKILL');
        }
      }
      this.executions.complete(executionId);
    }
  }

  private async nextLineWithIdleTimeout(
    iterator: AsyncIterator<string>,
    idleTimeoutMs: number,
    onTimeout: () => void,
  ): Promise<IteratorResult<string>> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<string>>((_, reject) => {
          timer = setTimeout(() => {
            onTimeout();
            reject(new Error(`Coco stream stalled after ${this.formatDuration(idleTimeoutMs)}`));
          }, idleTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private killChildTree(
    child: ReturnType<typeof spawn>,
    signal: NodeJS.Signals = 'SIGTERM',
  ): void {
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform !== 'win32' && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // group gone or not detached — fall through to direct kill
      }
    }
    try {
      child.kill(signal);
    } catch {
      // best-effort
    }
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
    return `${Math.max(1, Math.round(ms / 60_000))} minutes`;
  }
}
