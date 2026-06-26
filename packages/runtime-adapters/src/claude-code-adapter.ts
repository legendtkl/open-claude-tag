import { spawn } from 'child_process';
import { readFile, writeFile } from 'fs/promises';
import { extname, join } from 'path';
import { createLogger } from '@open-tag/observability';
import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type {
  Options as SDKOptions,
  SDKUserMessage,
  SpawnOptions,
} from '@anthropic-ai/claude-agent-sdk';
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

const logger = createLogger('claude-code-adapter');
const MAX_THINKING_SUMMARY_LENGTH = 500;

/**
 * Open capability descriptor for the Claude Code runtime. `id` is the open,
 * hyphenated display id; the persisted key stays `name() === 'claude_code'`.
 */
export const CLAUDE_CODE_DESCRIPTOR: RuntimeDescriptor = {
  id: 'claude-code',
  displayName: 'Claude Code',
  capabilities: {
    resume: true,
    // Read-only turns hard-deny the file-mutating tools (Edit/Write/MultiEdit/
    // NotebookEdit) via the SDK's disallowedTools — a real tool-level denial,
    // unlike Codex/Coco which leave read-only purely advisory. Bash itself stays
    // available for non-mutating inspection (the workflow prompt forbids
    // mutating shell commands).
    enforcesReadOnly: true,
    // Runtime capability: the Agent SDK supports an interactive per-tool
    // permission decision (canUseTool). Distinct from the runtimes below, which
    // have no interactive-approval path.
    interactivePermission: true,
    sandboxModes: ['readonly', 'workspace-write', 'danger-full-access'],
    // Prepared images are read and passed as base64 image content blocks.
    imageInput: 'base64',
    modelSelection: true,
  },
  // ANTHROPIC_* vars resolved by claude-config.ts (base URL + either auth env).
  credentialEnv: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'],
  workflowPrompts: { selfDev: 'self-dev-claude', readonly: 'readonly', default: 'general-task' },
};
type ClaudeImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

export interface ClaudeCodeConfig {
  baseUrl: string;
  authToken: string;
  model?: string;
  maxTurnCount?: number;
  /** Additional directories to allow tool access to (user-specified project dirs) */
  additionalDirs?: string[];
  /** Optional image downloader for handling image attachments in tasks */
  imageDownloader?: ImageDownloader;
  cancelSigtermGraceMs?: number;
  cancelSigkillGraceMs?: number;
}

export class ClaudeCodeAdapter implements RuntimeAdapter {
  private readonly executions: RuntimeExecutionRegistry;

  constructor(private readonly config: ClaudeCodeConfig) {
    this.executions = new RuntimeExecutionRegistry({
      runtimeName: 'claude_code',
      sigtermGraceMs: config.cancelSigtermGraceMs,
      sigkillGraceMs: config.cancelSigkillGraceMs,
      logger,
    });
  }

  name(): string {
    return 'claude_code';
  }

  descriptor(): RuntimeDescriptor {
    return CLAUDE_CODE_DESCRIPTOR;
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
    yield { type: 'status', message: 'Starting Claude Code...' };
    yield* this.runSDKQuery(
      spec.goal,
      handle.cwd,
      handle.executionId,
      spec,
      undefined,
      systemPromptAppend,
      handle.readOnly,
      handle.runtimeEnv,
      handle.imagePaths ?? [],
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
    yield { type: 'status', message: 'Resuming Claude Code session...' };
    yield* this.runSDKQuery(
      prompt,
      workspace.cwd ?? workspace.workspacePath,
      options.executionId ?? options.taskId ?? `resume-${Date.now()}`,
      undefined,
      sdkSessionId,
      systemPromptAppend,
      workspace.readOnly ?? false,
      workspace.runtimeEnv,
      options.imagePaths ?? [],
    );
  }

  async cancel(
    executionId: string,
    options: RuntimeCancelOptions = {},
  ): Promise<RuntimeCancelOutcome> {
    return this.executions.cancel(executionId, options);
  }

  async collectArtifacts(_executionId: string): Promise<ArtifactRef[]> {
    return [];
  }

  async healthcheck(): Promise<HealthStatus> {
    // The adapter is always available: registration is decoupled from global
    // env. Per-agent BASE_URL / API_KEY can supply custom credentials at
    // execution time, and otherwise Claude Code can use the local login state
    // on the execution host.
    const hasGlobalFallback = Boolean(this.config.authToken);
    return {
      healthy: true,
      name: 'claude_code',
      message: hasGlobalFallback
        ? 'Claude Agent SDK configured (global credentials present)'
        : 'Claude Agent SDK configured (local login or per-agent credentials)',
      lastCheckedAt: new Date(),
    };
  }

  private async *runSDKQuery(
    prompt: string,
    cwd: string,
    executionId: string,
    spec?: TaskSpec,
    resumeSessionId?: string,
    systemPromptAppend?: string,
    readOnly = false,
    runtimeEnv: Record<string, string> | undefined = undefined,
    imagePaths: string[] = [],
  ): AsyncGenerator<RuntimeEvent> {
    const abortController = new AbortController();
    this.executions.start(executionId, abortController);
    let runtimeStarted = false;
    let runtimeStartedEmitted = false;

    try {
      yield { type: 'progress', percent: 10, message: 'Claude Code processing...' };

      // Credential precedence (lowest → highest): process env, then the
      // adapter/global config defaults, then the per-agent runtimeEnv. The
      // per-agent values must win, mirroring how Codex carries per-agent
      // config via runtimeEnv.
      const env: Record<string, string | undefined> = { ...process.env };
      if (this.config.baseUrl) env.ANTHROPIC_BASE_URL = this.config.baseUrl;
      if (this.config.authToken) env.ANTHROPIC_API_KEY = this.config.authToken;
      Object.assign(env, runtimeEnv ?? {});

      // Explicit config wins. The heuristic default exists because workflow
      // tasks (every production task carries a systemPromptAppend) need many
      // turns for build+test+review+fix+commit+PR cycles.
      const defaultMaxTurns = this.config.maxTurnCount ?? (systemPromptAppend ? 200 : 10);

      const options: SDKOptions = {
        cwd,
        env,
        abortController,
        maxTurns: defaultMaxTurns,
        // Read-only turns keep default permissions and deny-list file-mutating
        // tools, while leaving Bash available for non-mutating inspection.
        permissionMode: readOnly ? 'default' : 'bypassPermissions',
        additionalDirectories: this.config.additionalDirs,
        settingSources: ['project'],
      };
      (
        options as SDKOptions & { spawnClaudeCodeProcess?: (options: SpawnOptions) => any }
      ).spawnClaudeCodeProcess = (spawnOptions: SpawnOptions) => {
        const child = spawn(spawnOptions.command, spawnOptions.args, {
          cwd: spawnOptions.cwd,
          env: spawnOptions.env,
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
        this.executions.attachChild(executionId, child);
        runtimeStarted = true;
        return child;
      };
      if (readOnly) {
        // Hard-deny direct file-editing tools. The readonly workflow prompt
        // still forbids mutating shell commands, but Bash itself remains useful
        // for inspection commands such as rg, ls, git status, and tests.
        (options as { disallowedTools?: string[] }).disallowedTools = [
          'Edit',
          'Write',
          'MultiEdit',
          'NotebookEdit',
        ];
      }

      if (systemPromptAppend) {
        (options as any).systemPrompt = {
          type: 'preset',
          preset: 'claude_code',
          append: systemPromptAppend,
        };
      }

      if (this.config.model) {
        options.model = this.config.model;
      }

      if (resumeSessionId) {
        options.resume = resumeSessionId;
      }

      const queryPrompt = await this.buildPromptInput(prompt, imagePaths);
      const queryStream = sdkQuery({ prompt: queryPrompt, options });

      let resultText = '';
      let sessionId = '';
      let totalCostUsd = 0;
      let tokenIn = 0;
      let tokenOut = 0;
      let durationMs = 0;
      let toolCount = 0;

      for await (const message of queryStream) {
        if (runtimeStarted && !runtimeStartedEmitted) {
          runtimeStartedEmitted = true;
          yield { type: 'runtime_started', executionId };
        }
        // Intermediate progress from assistant content blocks
        if (message.type === 'assistant') {
          const content = (message as any).message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'tool_use') {
                toolCount++;
                const percent = Math.min(15 + toolCount * 3, 80);
                yield {
                  type: 'progress',
                  percent,
                  message: formatToolPreview(block.name, block.input),
                };
                // Additive structured events for the named-stage checklist.
                // TodoWrite carries the real plan; other tools become tool_use
                // activity entries. The progress/status emission above is kept
                // so existing consumers stay unaffected.
                if (block.name === 'TodoWrite') {
                  const planUpdate = buildPlanUpdateFromTodos(block.input);
                  if (planUpdate) yield planUpdate;
                } else {
                  yield buildToolUseEvent(block.name, block.input);
                }
              } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
                const normalized = block.thinking.replace(/\s+/g, ' ').trim();
                if (normalized) {
                  const summary =
                    normalized.length > MAX_THINKING_SUMMARY_LENGTH
                      ? `${normalized.slice(0, MAX_THINKING_SUMMARY_LENGTH - 3)}...`
                      : normalized;
                  yield { type: 'reasoning', summary };
                }
              }
            }
          }
        }

        // Tool use summary for activity log
        if (message.type === 'tool_use_summary') {
          const summary = (message as any).summary;
          if (typeof summary === 'string' && summary.trim()) {
            yield { type: 'status', message: summary };
          }
        }

        if (message.type === 'result') {
          sessionId = message.session_id;
          durationMs = message.duration_ms;
          totalCostUsd = message.total_cost_usd;
          tokenIn = message.usage.input_tokens;
          tokenOut = message.usage.output_tokens;

          if (message.subtype === 'success') {
            resultText = message.result;
          } else {
            // Error result. The usage on this `result` message was already read
            // above, so surface it on the failure event — a task that spent
            // tokens then errored is still charged against its identity budget.
            const errors = (message as any).errors ?? [];
            yield {
              type: 'failed',
              error: errors.join('; ') || `Claude Code error: ${message.subtype}`,
              metrics: { tokenIn, tokenOut, estimatedCostUsd: totalCostUsd },
            };
            return;
          }
        }
      }

      yield { type: 'progress', percent: 90, message: 'Collecting results...' };

      // Emit session_created so worker can persist the SDK session ID
      if (sessionId) {
        yield { type: 'session_created', sdkSessionId: sessionId };
      }

      // Collect artifacts
      const artifacts = await collectArtifactsFromDir(join(cwd, 'artifacts'));
      for (const art of artifacts) {
        yield { type: 'artifact', ref: art };
      }

      const taskResult: TaskResult = {
        taskId: spec?.taskId ?? executionId,
        status: 'completed',
        output: { text: resultText },
        metrics: {
          durationMs,
          tokenIn,
          tokenOut,
          estimatedCostUsd: totalCostUsd,
        },
      };
      yield { type: 'completed', result: taskResult };
    } catch (err) {
      const message = errorMessage(err);
      if (abortController.signal.aborted) {
        yield { type: 'failed', error: message || 'Cancelled', reason: 'cancelled' };
        return;
      }
      yield { type: 'failed', error: message };
    } finally {
      this.executions.complete(executionId);
    }
  }


  private async buildPromptInput(
    prompt: string,
    imagePaths: string[],
  ): Promise<string | AsyncIterable<SDKUserMessage>> {
    if (imagePaths.length === 0) return prompt;

    const content: Array<
      | {
          type: 'image';
          source: { type: 'base64'; media_type: ClaudeImageMediaType; data: string };
        }
      | { type: 'text'; text: string }
    > = [];
    for (const imagePath of imagePaths) {
      try {
        const data = (await readFile(imagePath)).toString('base64');
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: this.mediaTypeForImagePath(imagePath), data },
        });
      } catch (err) {
        logger.warn({ imagePath, err }, 'Failed to read prepared image for Claude prompt');
      }
    }

    if (content.length === 0) return prompt;
    content.push({ type: 'text', text: prompt });

    return (async function* (): AsyncGenerator<SDKUserMessage> {
      yield {
        type: 'user',
        message: {
          role: 'user',
          content,
        },
        parent_tool_use_id: null,
        session_id: '',
      };
    })();
  }

  private mediaTypeForImagePath(imagePath: string): ClaudeImageMediaType {
    const extension = extname(imagePath).toLowerCase();
    if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
    if (extension === '.gif') return 'image/gif';
    if (extension === '.webp') return 'image/webp';
    return 'image/png';
  }
}

type PlanUpdateEvent = Extract<RuntimeEvent, { type: 'plan_update' }>;
type ToolUseEvent = Extract<RuntimeEvent, { type: 'tool_use' }>;
type PlanStepStatus = PlanUpdateEvent['steps'][number]['status'];

/** Map the SDK's TodoWrite states onto the 5-status plan-step set. */
function mapTodoStatus(status: unknown): PlanStepStatus {
  switch (status) {
    case 'in_progress':
      return 'running';
    case 'completed':
      return 'done';
    case 'pending':
    default:
      return 'pending';
  }
}

/**
 * Build a `plan_update` event from a TodoWrite tool_use input. Returns null when
 * the input has no usable todo list so callers can skip emitting an empty plan.
 */
function buildPlanUpdateFromTodos(input: Record<string, unknown>): PlanUpdateEvent | null {
  const todos = input && typeof input === 'object' ? (input as { todos?: unknown }).todos : undefined;
  if (!Array.isArray(todos)) return null;
  const steps = todos.map((todo, index) => {
    const t = (todo ?? {}) as { content?: unknown; activeForm?: unknown; status?: unknown };
    const content = typeof t.content === 'string' ? t.content.trim() : '';
    const activeForm = typeof t.activeForm === 'string' ? t.activeForm.trim() : '';
    const title = content || activeForm || `Step ${index + 1}`;
    return { id: `step-${index}`, title, status: mapTodoStatus(t.status) };
  });
  return { type: 'plan_update', steps };
}

/** Build a structured `tool_use` activity event for a non-TodoWrite tool call. */
function buildToolUseEvent(name: string, input: Record<string, unknown>): ToolUseEvent {
  return {
    type: 'tool_use',
    name,
    summary: formatToolPreview(name, input),
    // The assistant block represents the model invoking the tool; we don't have
    // the result yet, so the call is in flight.
    status: 'running',
  };
}

function formatToolPreview(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
    case 'bash': {
      const cmd = typeof input?.command === 'string' ? input.command : '';
      return cmd
        ? `Running: ${cmd.length > 60 ? cmd.slice(0, 57) + '...' : cmd}`
        : 'Running: shell command';
    }
    case 'Read':
    case 'read':
      return `Reading: ${input?.file_path ?? 'file'}`;
    case 'Edit':
    case 'edit':
    case 'MultiEdit':
      return `Editing: ${input?.file_path ?? 'file'}`;
    case 'Write':
    case 'write':
      return `Writing: ${input?.file_path ?? 'file'}`;
    case 'Grep':
    case 'grep':
      return `Searching: ${input?.pattern ?? 'pattern'}`;
    case 'Glob':
    case 'glob':
      return `Finding files: ${input?.pattern ?? 'pattern'}`;
    case 'Agent':
    case 'agent':
      return `Running agent: ${input?.description ?? 'sub-task'}`;
    default:
      return `Using: ${toolName}`;
  }
}
