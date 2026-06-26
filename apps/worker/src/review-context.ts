import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

import { truncateText } from '@open-tag/core-types';

import { getEffectiveTaskConstraints, isRecord } from './task-constraints.js';

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function nullableStringValue(value: unknown): string | null | undefined {
  if (value === null) return null;
  return stringValue(value);
}

function stringifyReviewValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return undefined;
  }
}

function isExistingDirectory(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface ReviewWorktreeAvailabilityInput {
  worktreePath?: string;
  sourceMachineId?: string | null;
  currentMachineId?: string | null;
}

function isReviewWorktreeAvailable(input: ReviewWorktreeAvailabilityInput): boolean {
  if (!input.worktreePath || !isAbsolute(input.worktreePath)) return false;

  const currentMachineId = input.currentMachineId ?? null;
  if (input.sourceMachineId !== undefined) {
    if (input.sourceMachineId !== currentMachineId) return false;
    return currentMachineId ? true : isExistingDirectory(input.worktreePath);
  }

  return currentMachineId ? false : isExistingDirectory(input.worktreePath);
}

export function getReviewContext(constraints: Record<string, unknown>): Record<string, unknown> | null {
  const reviewContext = getEffectiveTaskConstraints(constraints).reviewContext;
  return isRecord(reviewContext) ? reviewContext : null;
}

export function getReviewContextWorkDir(
  constraints: Record<string, unknown>,
  options: { currentMachineId?: string | null } = {},
): string | undefined {
  const reviewContext = getReviewContext(constraints);
  const worktreePath = stringValue(reviewContext?.worktreePath);
  const sourceMachineId = nullableStringValue(reviewContext?.sourceMachineId);
  return isReviewWorktreeAvailable({
    worktreePath,
    sourceMachineId,
    currentMachineId: options.currentMachineId,
  })
    ? worktreePath
    : undefined;
}

export function getReviewContextWorktreeAccessMode(
  constraints: Record<string, unknown>,
): 'readonly' | 'write' {
  return getReviewContext(constraints) ? 'write' : 'readonly';
}

export function appendReviewContextGuidance(
  systemPrompt: string | undefined,
  constraints: Record<string, unknown>,
  options: { currentMachineId?: string | null } = {},
): string | undefined {
  const reviewContext = getReviewContext(constraints);
  if (!reviewContext) return systemPrompt;

  const lines = [
    systemPrompt ?? '',
    '',
    '<review_context>',
    `source: ${stringValue(reviewContext.source) ?? 'unknown'}`,
  ];

  const worktreePath = stringValue(reviewContext.worktreePath);
  const sourceMachineId = nullableStringValue(reviewContext.sourceMachineId);
  const currentMachineId = options.currentMachineId ?? null;
  const worktreeAvailable = isReviewWorktreeAvailable({
    worktreePath,
    sourceMachineId,
    currentMachineId,
  });
  if (sourceMachineId !== undefined) {
    lines.push(`source_machine_id: ${sourceMachineId ?? 'server-local'}`);
    lines.push(`current_machine_id: ${currentMachineId ?? 'server-local'}`);
  }
  if (worktreePath) {
    lines.push(`worktree_path: ${worktreePath}`);
    lines.push(`worktree_available: ${worktreeAvailable ? 'true' : 'false'}`);
  }

  const missingReason = stringValue(reviewContext.missingReason);
  if (missingReason) {
    lines.push(`missing_reason: ${missingReason}`);
  }

  const referencedHandle = stringValue(reviewContext.referencedHandle);
  if (referencedHandle) {
    lines.push(`referenced_agent: ${referencedHandle}`);
  }

  const referencedAgentId = stringValue(reviewContext.referencedAgentId);
  if (referencedAgentId) {
    lines.push(`referenced_agent_id: ${referencedAgentId}`);
  }

  const parentTaskId = stringValue(reviewContext.parentTaskId);
  if (parentTaskId) {
    lines.push(`parent_task_id: ${parentTaskId}`);
  }

  const reviewedTaskId = stringValue(reviewContext.reviewedTaskId);
  if (reviewedTaskId) {
    lines.push(`reviewed_task_id: ${reviewedTaskId}`);
  }

  const reviewedGoal = stringValue(reviewContext.reviewedGoal);
  if (reviewedGoal) {
    lines.push('', '<reviewed_goal>', reviewedGoal, '</reviewed_goal>');
  }

  const delegateGoal = stringValue(reviewContext.delegateGoal);
  if (delegateGoal) {
    lines.push('', '<delegate_goal>', delegateGoal, '</delegate_goal>');
  }

  const worktreeAccessMode = getReviewContextWorktreeAccessMode(constraints);
  lines.push(`worktree_access_mode: ${worktreeAccessMode}`);

  const reviewedResult = stringifyReviewValue(reviewContext.reviewedResult);
  if (reviewedResult) {
    lines.push(
      '',
      '<reviewed_result>',
      truncateText(reviewedResult, 8000, { suffix: '\n...(truncated)' }),
      '</reviewed_result>',
    );
  }

  lines.push(
    '',
    worktreeAvailable
      ? 'Use the referenced worktree above as the target workspace for this delegated task. You may modify it when the delegated goal requires changes.'
      : worktreePath && sourceMachineId !== undefined && sourceMachineId !== currentMachineId
        ? 'The referenced worktree is on a different execution machine and is unavailable here. Work from the referenced goal/result context, or ask the previous agent to publish a branch, patch, or snapshot artifact before doing file-level review.'
      : 'No usable referenced worktree is available. Work from the referenced goal/result context only, and explicitly mention that the source worktree was unavailable.',
    '</review_context>',
  );

  return lines.filter((line, index) => index === 0 || line.length > 0 || lines[index - 1] !== '').join('\n');
}
