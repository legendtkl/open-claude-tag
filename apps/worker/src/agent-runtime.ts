import type { FeishuClient } from '@open-tag/feishu-adapter';
import type { TaskJobData } from '@open-tag/queue';
import type { AgentSessionStateRecord } from '@open-tag/storage';

export interface TaskAgentIdentity {
  agentId?: string;
  feishuAppId?: string;
}

export interface TaskAgentIdentityRow {
  agentId?: string | null;
  feishuAppId?: string | null;
}

export interface EffectiveRuntimeState {
  runtimeBackend?: string | null;
  sdkSessionId?: string | null;
  sdkSessionMachineId?: string | null;
  workspacePath?: string | null;
  worktreeBranch?: string | null;
  adhocWorkDir?: string | null;
}

export interface AgentSystemPromptInput {
  platformPrompt?: string | null;
  identityPrompt?: string | null;
  agentSystemPrompt?: string | null;
  workflowPrompt?: string | null;
}

export interface AgentIdentityPromptInput {
  agentId?: string | null;
  handle?: string | null;
  displayName?: string | null;
}

export interface TaskFeishuClientResolver {
  getClient(feishuAppId?: string | null): Promise<FeishuClient | null>;
}

export interface TaskFeishuClientResolution {
  client: FeishuClient | null;
  missingAppClient: boolean;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

export function resolveTaskAgentIdentity(
  jobData: TaskJobData,
  taskRow?: TaskAgentIdentityRow | null,
): TaskAgentIdentity {
  const constraints = jobData.constraints as Record<string, unknown>;

  return {
    agentId:
      stringValue(taskRow?.agentId) ??
      stringValue(jobData.agentId) ??
      stringValue(constraints.agentId),
    feishuAppId:
      stringValue(taskRow?.feishuAppId) ??
      stringValue(jobData.feishuAppId) ??
      stringValue(constraints.feishuAppId),
  };
}

export function resolveEffectiveRuntimeState(input: {
  agentId?: string;
  agentSessionState?: AgentSessionStateRecord | null;
  jobData: TaskJobData;
}): EffectiveRuntimeState {
  if (!input.agentId) {
    return {
      runtimeBackend: input.jobData.runtimeBackend ?? null,
      sdkSessionId: input.jobData.sdkSessionId ?? null,
      sdkSessionMachineId: input.jobData.sdkSessionMachineId ?? null,
    };
  }

  return {
    runtimeBackend: input.agentSessionState?.runtimeBackend ?? null,
    sdkSessionId: input.agentSessionState?.sdkSessionId ?? null,
    sdkSessionMachineId: input.agentSessionState?.sdkSessionMachineId ?? null,
    workspacePath: input.agentSessionState?.workspacePath ?? null,
    worktreeBranch: input.agentSessionState?.worktreeBranch ?? null,
    adhocWorkDir: input.agentSessionState?.adhocWorkDir ?? null,
  };
}

export function shouldClearSdkSessionForRuntimeSwitch(
  previousRuntimeBackend?: string | null,
  selectedRuntimeBackend?: string | null,
): boolean {
  return Boolean(
    previousRuntimeBackend &&
      selectedRuntimeBackend &&
      previousRuntimeBackend !== selectedRuntimeBackend,
  );
}

export function buildWorkerWorkspaceKey(sessionId: string, agentId?: string): string {
  if (!agentId) return sessionId;

  const agentPart = agentId.replace(/-/g, '').slice(0, 4) || 'agent';
  const sessionPart = sessionId.replace(/-/g, '').slice(0, 4) || 'sess';
  return `${agentPart}${sessionPart}-${sessionId}`;
}

/**
 * Extract the conversation thread discriminator from a session key.
 *
 * Only thread-scoped sessions (`feishu:{tenant}:{chatId}:thread:{threadId}`)
 * identify a reusable conversation thread; group-main, manual (`/new`), and
 * bootstrap sessions deliberately return `null` so they keep their per-task
 * workspace behavior. The match is anchored to the end of the key (a strict
 * `:thread:<id>` suffix), not a loose substring scan, and a malformed or empty
 * thread component falls back to `null`.
 */
export function deriveConversationThreadId(sessionKey: string | null | undefined): string | null {
  if (!sessionKey) return null;
  const match = /:thread:([^:]+)$/.exec(sessionKey);
  if (!match) return null;
  const threadId = match[1].trim();
  return threadId.length > 0 ? threadId : null;
}

export function mergeAgentProfileSystemPrompt(input: {
  systemPrompt?: string | null;
  legacyStylePrompt?: string | null;
}): string | undefined {
  const sections = [input.systemPrompt, input.legacyStylePrompt]
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section));

  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    result.push(trimmed);
  }
  return result;
}

export function buildAgentIdentityPrompt(input: AgentIdentityPromptInput): string | undefined {
  const agentId = input.agentId?.trim();
  if (!agentId) return undefined;

  const aliases = uniqueStrings([input.displayName, input.handle]);
  const identity = {
    agentId,
    displayName: input.displayName?.trim() || undefined,
    handle: input.handle?.trim() || undefined,
    mentionAliases: aliases.map((alias) => `@${alias}`),
  };

  return [
    'You are executing as a specific OpenClaudeTag agent. Keep this identity separate from other agents in the same chat.',
    '<agent_identity>',
    JSON.stringify(identity, null, 2),
    '</agent_identity>',
    aliases.length > 0
      ? `Mentions ${aliases.map((alias) => `@${alias}`).join(', ')} refer to you.`
      : 'Use agent_id to identify work addressed to you.',
    'This queued task has already been routed to this agent by the server. Treat that assignment as authoritative.',
    'Do not refuse the task solely because the original Feishu text also contains another bot mention; treat unrelated bot mentions as routing context unless the user explicitly assigns a separate subtask to that bot.',
    'If a user message mentions multiple agents, perform only the part addressed to your identity and use the handoff workflow for work assigned to another agent.',
  ].join('\n');
}

export function buildAgentSystemPrompt(input: AgentSystemPromptInput): string | undefined {
  const sections = [
    input.platformPrompt,
    input.identityPrompt,
    input.agentSystemPrompt,
    input.workflowPrompt,
  ]
    .map((section) => section?.trim())
    .filter((section): section is string => Boolean(section));

  return sections.length > 0 ? sections.join('\n\n---\n\n') : undefined;
}

export function normalizeRuntimeEnv(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, string] =>
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry[0]) && typeof entry[1] === 'string',
    ),
  );
}

export async function resolveTaskFeishuClient(input: {
  feishuAppId?: string | null;
  resolver: TaskFeishuClientResolver | null;
  defaultClient: FeishuClient | null;
}): Promise<TaskFeishuClientResolution> {
  if (input.feishuAppId) {
    const client = (await input.resolver?.getClient(input.feishuAppId)) ?? null;
    return {
      client,
      missingAppClient: !client,
    };
  }

  const primaryClient = input.resolver ? await input.resolver.getClient(null) : null;
  return {
    client: primaryClient ?? input.defaultClient,
    missingAppClient: false,
  };
}
