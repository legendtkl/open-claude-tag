import { stableUuidFromKey } from '@open-tag/core-types';
import { isObjectRecord as isRecord } from '@open-tag/core-types';
import type { CreateDelegatedTaskInput, CreateDelegatedTaskResult } from '@open-tag/orchestrator';
import type { TaskJobData } from '@open-tag/queue';

interface HandoffLogger {
  info(meta: Record<string, unknown>, message: string): void;
  warn(meta: Record<string, unknown>, message: string): void;
  error(meta: Record<string, unknown>, message: string): void;
}

export interface HandoffTargetResolution {
  agentId: string;
  feishuAppId?: string | null;
  handle?: string | null;
}

/**
 * A delegable agent offered to the LLM under a session-local short code (e.g.
 * `agent_1`). The model hands off by code, not by name or UUID: the code maps
 * back to a real `agentId` through this roster, so routing uses the id, names
 * may repeat across owners, and the model can never reach an agent outside the
 * roster (it cannot invent a code that resolves).
 */
export interface HandoffCandidate {
  ref: string;
  agentId: string;
  displayName: string;
  feishuAppId?: string | null;
}

export interface HandoffDeliveryDeps {
  createDelegatedTask(input: CreateDelegatedTaskInput): Promise<CreateDelegatedTaskResult>;
  resolveAgentByHandle(handle: string): Promise<HandoffTargetResolution | null>;
  enqueue(jobData: TaskJobData): Promise<string | null>;
  deleteLease(taskId: string): Promise<void>;
  sendVisibleRelayWake?(input: {
    chatId: string;
    text: string;
    replyToMessageId?: string;
    uuid: string;
  }): Promise<{ messageId: string }>;
  logger: HandoffLogger;
}

export type HandoffDeliveryResult =
  | { status: 'not_applicable' }
  | { status: 'visible_relay_notified'; messageId: string }
  | { status: 'visible_relay_failed' }
  | { status: 'delegated_return'; childTaskId: string }
  | { status: 'delegated_chain'; childTaskId: string }
  | { status: 'lease_retained'; childTaskId: string; mode: 'return' | 'chain' };

interface ParsedHandoffCall {
  handle: string;
  goal: string;
  expectedOutput?: string;
  mode: 'return' | 'chain';
}


function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function modeValue(value: unknown): 'return' | 'chain' {
  return value === 'chain' ? 'chain' : 'return';
}

function routingRecord(constraints: Record<string, unknown>): Record<string, unknown> | null {
  const routing = constraints.multiMentionRouting;
  return isRecord(routing) ? routing : null;
}

function parseRelayPlan(
  constraints: Record<string, unknown>,
): (ParsedHandoffCall & {
  relayKey: string;
  targetAgentId: string;
  targetFeishuAppId?: string;
  targetBotOpenId: string;
  primaryHandle?: string;
  chatId?: string;
  replyToMessageId?: string;
}) | null {
  if (constraints.delegationResume === true) {
    return null;
  }

  const routing = routingRecord(constraints);
  if (!routing || routing.route !== 'relay' || routing.status !== 'pending') {
    return null;
  }
  const relayKey = stringValue(routing.relayKey);
  const target = isRecord(routing.target) ? routing.target : {};
  const primary = isRecord(routing.primary) ? routing.primary : {};
  const targetAgentId = stringValue(target.agentId);
  const targetBotOpenId = stringValue(target.botOpenId);
  const handle = stringValue(routing.targetHandle) ?? stringValue(routing.nextAgentHandle) ??
    stringValue(target.handle);
  const goal = stringValue(routing.goal) ?? stringValue(routing.ask);
  if (!relayKey || !targetAgentId || !targetBotOpenId || !handle || !goal) {
    return null;
  }
  return {
    relayKey,
    targetAgentId,
    targetFeishuAppId: stringValue(target.feishuAppId),
    targetBotOpenId,
    primaryHandle: stringValue(primary.handle) ?? stringValue(primary.displayName),
    chatId: stringValue(constraints.chatId),
    replyToMessageId: stringValue(constraints.replyToMessageId) ?? stringValue(constraints.userMessageId),
    handle,
    goal,
    expectedOutput: stringValue(routing.expectedOutput) ?? 'Review the primary agent output.',
    mode: modeValue(routing.mode),
  };
}

function visibleMention(handle: string): string {
  return handle.startsWith('@') ? handle : `@${handle}`;
}

function escapeFeishuAtText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildFeishuBotMention(openId: string, label: string): string {
  const mentionName = visibleMention(label).replace(/^@+/, '');
  return `<at user_id="${openId}">${escapeFeishuAtText(mentionName)}</at>`;
}

function buildVisibleRelayWakeText(
  plan: ParsedHandoffCall & { primaryHandle?: string; targetBotOpenId: string },
): string {
  const target = buildFeishuBotMention(plan.targetBotOpenId, plan.handle);
  const primary = plan.primaryHandle ? visibleMention(plan.primaryHandle) : '上一个 agent';
  return `${target} ${plan.goal} ${primary} 的结果`;
}

export function extractHandoffToolCall(outputText: string): ParsedHandoffCall | null {
  const tagged = /<handoff_to_agent>\s*([\s\S]*?)\s*<\/handoff_to_agent>/i.exec(outputText);
  const inline = /handoff_to_agent\s*\(\s*({[\s\S]*?})\s*\)/i.exec(outputText);
  const raw = tagged?.[1] ?? inline?.[1];
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    // Prefer the new `agent` short code; fall back to the legacy `handle` field
    // so prompts emitted before this change still resolve. Either way the value
    // rides in `handle`, which the resolver maps to a real agent id.
    const ref = stringValue(parsed.agent) ?? stringValue(parsed.handle);
    const goal = stringValue(parsed.goal);
    if (!ref || !goal) return null;
    return {
      handle: ref,
      goal,
      expectedOutput: stringValue(parsed.expected_output) ?? stringValue(parsed.expectedOutput),
      mode: modeValue(parsed.mode),
    };
  } catch {
    return null;
  }
}

function buildContextSummary(input: {
  parentGoal: string;
  outputText: string;
  source: 'relay' | 'tool';
}): string {
  return [
    input.source === 'relay'
      ? 'Primary agent completed and requested the planned relay handoff.'
      : 'Caller agent invoked handoff_to_agent.',
    '',
    '<parent_goal>',
    input.parentGoal,
    '</parent_goal>',
    '',
    '<parent_output>',
    input.outputText || '(No parent output text.)',
    '</parent_output>',
  ].join('\n');
}

async function enqueueDelegatedChild(
  deps: HandoffDeliveryDeps,
  result: CreateDelegatedTaskResult,
  mode: 'return' | 'chain',
): Promise<HandoffDeliveryResult> {
  try {
    const jobId = await deps.enqueue(result.job);
    if (!jobId) {
      deps.logger.warn(
        { childTaskId: result.childTaskId, mode },
        'Handoff child enqueue hit singleton collision; durable lease retained',
      );
      return { status: 'lease_retained', childTaskId: result.childTaskId, mode };
    }
    await deps.deleteLease(result.childTaskId);
    deps.logger.info(
      { childTaskId: result.childTaskId, mode, jobId },
      'Handoff child task enqueued',
    );
    return {
      status: mode === 'chain' ? 'delegated_chain' : 'delegated_return',
      childTaskId: result.childTaskId,
    };
  } catch (err) {
    deps.logger.error(
      { err, childTaskId: result.childTaskId, mode },
      'Handoff child enqueue failed; durable lease retained',
    );
    return { status: 'lease_retained', childTaskId: result.childTaskId, mode };
  }
}

async function deliverHandoff(input: {
  deps: HandoffDeliveryDeps;
  parentTaskId: string;
  callerAgentId: string;
  targetAgentId: string;
  targetFeishuAppId?: string | null;
  idempotencyKey: string;
  mode: 'return' | 'chain';
  goal: string;
  expectedOutput?: string;
  contextSummary: string;
  constraints: Record<string, unknown>;
}): Promise<HandoffDeliveryResult> {
  const result = await input.deps.createDelegatedTask({
    parentTaskId: input.parentTaskId,
    callerAgentId: input.callerAgentId,
    calleeAgentId: input.targetAgentId,
    calleeFeishuAppId: input.targetFeishuAppId,
    childTaskId: stableUuidFromKey(`${input.idempotencyKey}:child-task`),
    childSessionId: stableUuidFromKey(`${input.idempotencyKey}:child-session`),
    mode: input.mode,
    goal: input.goal,
    contextSummary: input.contextSummary,
    expectedOutput: input.expectedOutput,
    constraints: input.constraints,
  });
  return enqueueDelegatedChild(input.deps, result, input.mode);
}

export async function deliverRelayHandoffIfNeeded(
  deps: HandoffDeliveryDeps,
  input: {
    taskId: string;
    callerAgentId?: string | null;
    constraints: Record<string, unknown>;
    parentGoal: string;
    outputText: string;
    parentWorkspacePath?: string;
  },
): Promise<HandoffDeliveryResult> {
  const plan = parseRelayPlan(input.constraints);
  if (!plan) return { status: 'not_applicable' };
  if (!deps.sendVisibleRelayWake || !plan.chatId) {
    deps.logger.warn(
      { taskId: input.taskId, relayKey: plan.relayKey, hasSender: Boolean(deps.sendVisibleRelayWake) },
      'Visible relay wake cannot be posted because Feishu context is unavailable',
    );
    return { status: 'visible_relay_failed' };
  }

  try {
    const result = await deps.sendVisibleRelayWake({
      chatId: plan.chatId,
      text: buildVisibleRelayWakeText(plan),
      replyToMessageId: plan.replyToMessageId,
      uuid: `${plan.relayKey}:visible-wake`,
    });
    deps.logger.info(
      {
        taskId: input.taskId,
        relayKey: plan.relayKey,
        messageId: result.messageId,
        targetHandle: plan.handle,
      },
      'Visible relay wake message posted',
    );
    return { status: 'visible_relay_notified', messageId: result.messageId };
  } catch (err) {
    deps.logger.error(
      { err, taskId: input.taskId, relayKey: plan.relayKey },
      'Visible relay wake message failed',
    );
    return { status: 'visible_relay_failed' };
  }
}

export async function deliverAgentHandoffToolCallIfNeeded(
  deps: HandoffDeliveryDeps,
  input: {
    taskId: string;
    callerAgentId?: string | null;
    constraints: Record<string, unknown>;
    parentGoal: string;
    outputText: string;
  },
): Promise<HandoffDeliveryResult> {
  const call = extractHandoffToolCall(input.outputText);
  if (!call) return { status: 'not_applicable' };
  if (!input.callerAgentId) {
    throw new Error('handoff_to_agent caller task has no agent identity');
  }
  const target = await deps.resolveAgentByHandle(call.handle);
  if (!target) {
    throw new Error(`handoff_to_agent target not found: ${call.handle}`);
  }

  const callIndex = 0;
  const idempotencyKey = ['handoff-tool', input.taskId, target.agentId, `call-${callIndex}`].join(
    ':',
  );
  return deliverHandoff({
    deps,
    parentTaskId: input.taskId,
    callerAgentId: input.callerAgentId,
    targetAgentId: target.agentId,
    targetFeishuAppId: target.feishuAppId,
    idempotencyKey,
    mode: call.mode,
    goal: call.goal,
    expectedOutput: call.expectedOutput,
    contextSummary: buildContextSummary({
      parentGoal: input.parentGoal,
      outputText: input.outputText,
      source: 'tool',
    }),
    constraints: {
      handoffSource: 'tool',
      targetHandle: call.handle,
      handoffCallIndex: callIndex,
      requestedMode: call.mode,
    },
  });
}

export interface WaitingContractWakeRecord {
  id: string;
  agentId: string;
  goal: string;
  chatId: string;
  messageId: string;
}

export interface WaitingContractWakeDeps {
  listWaitingContracts(input: {
    messageId: string;
    waitingOnAgentId: string;
  }): Promise<WaitingContractWakeRecord[]>;
  /** Atomic waiting→<to> CAS; resolves true only when this call won the transition. */
  transitionContract(contractId: string, to: 'woken' | 'cancelled'): Promise<boolean>;
  /** Compensation: put a claimed contract back to waiting after a failed send. */
  revertContract(contractId: string, from: 'woken' | 'cancelled'): Promise<boolean>;
  resolveAgentMention(
    agentId: string,
  ): Promise<{ botOpenId: string | null; displayName: string } | null>;
  sendVisibleRelayWake?: HandoffDeliveryDeps['sendVisibleRelayWake'];
  logger: HandoffLogger;
}

/**
 * Consume waiting contracts when the primary task reaches a terminal state.
 *
 * Completed: the atomic `waiting → woken` CAS is won FIRST (it is the
 * exactly-once gate — duplicate completions and agent-authored mentions racing
 * the hook lose the CAS and send nothing), then the visible wake that really
 * `<at>`-mentions the deferred bot is posted. A failed send reverts the claim
 * to `waiting` so the reconciler or the next completion retries; the wake uuid
 * is contract-derived so a retried send can never double-post on the Feishu
 * side either. The unrecoverable window is a crash between CAS and send,
 * accepted and documented in the design (D4).
 * Failed: same claim/revert protocol into `cancelled`, with a plain-text
 * notice (deliberately NOT a real mention, so cancellation cannot trigger the
 * bot).
 */
export async function deliverWaitingContractWakes(
  deps: WaitingContractWakeDeps,
  input: {
    taskId: string;
    agentId?: string | null;
    constraints: Record<string, unknown>;
    outcome: 'completed' | 'failed';
  },
): Promise<{ woken: number; cancelled: number }> {
  const none = { woken: 0, cancelled: 0 };
  if (!input.agentId) return none;
  const messageId =
    stringValue(input.constraints.userMessageId) ?? stringValue(input.constraints.replyToMessageId);
  if (!messageId) return none;

  const contracts = await deps.listWaitingContracts({
    messageId,
    waitingOnAgentId: input.agentId,
  });
  if (contracts.length === 0) return none;

  if (!deps.sendVisibleRelayWake) {
    deps.logger.warn(
      { taskId: input.taskId, messageId, contracts: contracts.length },
      'Waiting contracts found but Feishu context is unavailable; leaving for reconciler',
    );
    return none;
  }

  const primaryMention = await deps.resolveAgentMention(input.agentId);
  const primaryName = primaryMention?.displayName ?? 'primary agent';
  let woken = 0;
  let cancelled = 0;

  for (const contract of contracts) {
    if (input.outcome === 'failed') {
      if (!(await deps.transitionContract(contract.id, 'cancelled'))) {
        continue;
      }
      try {
        await deps.sendVisibleRelayWake({
          chatId: contract.chatId,
          text: `已取消等待：@${primaryName} 的任务失败，原定后续(${contract.goal})不再自动触发。`,
          replyToMessageId: contract.messageId,
          uuid: `wc:${contract.id}:cancel`,
        });
        cancelled += 1;
      } catch (err) {
        await deps.revertContract(contract.id, 'cancelled');
        deps.logger.warn(
          { err, taskId: input.taskId, contractId: contract.id },
          'Cancellation notice failed; contract reverted to waiting for reconciler retry',
        );
      }
      continue;
    }

    const target = await deps.resolveAgentMention(contract.agentId);
    if (!target?.botOpenId) {
      deps.logger.error(
        { taskId: input.taskId, contractId: contract.id, targetAgentId: contract.agentId },
        'Cannot wake waiting contract: target bot open id unresolved; leaving for reconciler',
      );
      continue;
    }
    if (!(await deps.transitionContract(contract.id, 'woken'))) {
      continue;
    }
    try {
      const result = await deps.sendVisibleRelayWake({
        chatId: contract.chatId,
        text: `${buildFeishuBotMention(target.botOpenId, target.displayName)} ${contract.goal}（@${primaryName} 已完成，请基于其结果继续）`,
        replyToMessageId: contract.messageId,
        uuid: `wc:${contract.id}:wake`,
      });
      woken += 1;
      deps.logger.info(
        {
          taskId: input.taskId,
          contractId: contract.id,
          wakeMessageId: result.messageId,
          targetAgentId: contract.agentId,
        },
        'Waiting contract wake posted',
      );
    } catch (err) {
      await deps.revertContract(contract.id, 'woken');
      deps.logger.error(
        { err, taskId: input.taskId, contractId: contract.id },
        'Wake send failed; contract reverted to waiting for reconciler retry',
      );
    }
  }

  return { woken, cancelled };
}

export function appendHandoffToolGuidance(
  systemPrompt: string,
  candidates: HandoffCandidate[] = [],
): string {
  // No delegable agents → omit the tool entirely so the model is not told to
  // hand off with no valid target.
  if (candidates.length === 0) {
    return systemPrompt;
  }
  const roster = candidates.map((c) => `[${c.ref}] ${c.displayName}`).join('\n');
  return [
    systemPrompt,
    '',
    '<handoff_tool>',
    'When another OpenClaudeTag agent should take a bounded subtask, emit exactly one handoff call in your final answer.',
    'Pick the target by its short code from this roster — do NOT invent codes or use names/ids:',
    roster,
    'Call shape:',
    '<handoff_to_agent>{"agent":"agent_1","goal":"specific task","expected_output":"what to return","mode":"return"}</handoff_to_agent>',
    'Use mode "return" when you need the result back before answering the user; use "chain" for a forward-only handoff.',
    '</handoff_tool>',
  ].join('\n');
}
