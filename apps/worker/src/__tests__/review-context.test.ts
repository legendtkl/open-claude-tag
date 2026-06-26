import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendReviewContextGuidance,
  getReviewContextWorkDir,
  getReviewContextWorktreeAccessMode,
} from '../review-context.js';
import { getEffectiveTaskConstraints } from '../task-constraints.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'open-claude-tag-review-context-'));
  tempDirs.push(dir);
  return dir;
}

describe('review context workspace resolution', () => {
  it('uses an existing review worktree as the transient task cwd', () => {
    const worktreePath = tempWorktree();

    expect(
      getReviewContextWorkDir({
        confirmedWorkDir: '/chat/default',
        reviewContext: {
          source: 'reference',
          worktreePath,
          reviewedResult: 'done',
        },
      }),
    ).toBe(worktreePath);
  });

  it('uses nested delegated review context from the real delegated child shape', () => {
    const worktreePath = tempWorktree();
    const constraints = {
      delegatedTask: true,
      delegationPackage: {
        constraints: {
          confirmedWorkDir: '/chat/default',
          reviewContext: {
            source: 'relay',
            worktreePath,
            reviewedGoal: '新增一个文件 10.txt，完成之后让 @Reviewer 进行 Review',
            reviewedResult: 'done',
          },
        },
      },
    };

    expect(getReviewContextWorkDir(constraints)).toBe(worktreePath);
    expect(getEffectiveTaskConstraints(constraints).confirmedWorkDir).toBe('/chat/default');
    expect(appendReviewContextGuidance('base', constraints)).toContain(worktreePath);
  });

  it('lets top-level constraints override nested delegated constraints', () => {
    const nestedWorktreePath = tempWorktree();
    const topLevelWorktreePath = tempWorktree();

    const constraints = {
      confirmedWorkDir: '/top/default',
      reviewContext: {
        source: 'reference',
        worktreePath: topLevelWorktreePath,
        reviewedResult: 'top-level',
      },
      delegationPackage: {
        constraints: {
          confirmedWorkDir: '/nested/default',
          reviewContext: {
            source: 'relay',
            worktreePath: nestedWorktreePath,
            reviewedResult: 'nested',
          },
        },
      },
    };

    const effectiveConstraints = getEffectiveTaskConstraints(constraints);

    expect(getReviewContextWorkDir(constraints)).toBe(topLevelWorktreePath);
    expect(effectiveConstraints.confirmedWorkDir).toBe('/top/default');
    expect(appendReviewContextGuidance('base', constraints)).toContain('source: reference');
  });

  it('falls back when the review worktree path no longer exists', () => {
    expect(
      getReviewContextWorkDir({
        reviewContext: {
          source: 'reference',
          worktreePath: '/path/that/does/not/exist',
          missingReason: 'worktree_unavailable',
          reviewedResult: 'done',
        },
      }),
    ).toBeUndefined();

    expect(
      appendReviewContextGuidance('base', {
        reviewContext: {
          source: 'reference',
          worktreePath: '/path/that/does/not/exist',
          missingReason: 'worktree_unavailable',
          reviewedResult: 'done',
        },
      }),
    ).toContain('No usable referenced worktree is available');
  });

  it('uses a remote review worktree only on the source machine', () => {
    const constraints = {
      reviewContext: {
        source: 'reference',
        worktreePath: '/remote/dev/worktree',
        sourceMachineId: 'machine-a',
        reviewedResult: 'done',
      },
    };

    expect(getReviewContextWorkDir(constraints, { currentMachineId: 'machine-a' })).toBe(
      '/remote/dev/worktree',
    );
    expect(getReviewContextWorkDir(constraints, { currentMachineId: 'machine-b' })).toBeUndefined();
  });

  it('marks a referenced worktree unavailable across different machines', () => {
    const guidance = appendReviewContextGuidance(
      'base',
      {
        reviewContext: {
          source: 'reference',
          worktreePath: '/remote/dev/worktree',
          sourceMachineId: 'machine-a',
          reviewedResult: 'done',
        },
      },
      { currentMachineId: 'machine-b' },
    );

    expect(guidance).toContain('source_machine_id: machine-a');
    expect(guidance).toContain('current_machine_id: machine-b');
    expect(guidance).toContain('worktree_available: false');
    expect(guidance).toContain('publish a branch, patch, or snapshot artifact');
  });

  it('defaults delegated review context to write access mode', () => {
    const worktreePath = tempWorktree();

    expect(
      getReviewContextWorktreeAccessMode({
        reviewContext: {
          source: 'reference',
          worktreePath,
          delegateGoal: 'review the result',
        },
      }),
    ).toBe('write');

    expect(
      appendReviewContextGuidance('base', {
        reviewContext: {
          source: 'reference',
          worktreePath,
          delegateGoal: 'review the result',
        },
      }),
    ).toContain('You may modify it');
  });
});
