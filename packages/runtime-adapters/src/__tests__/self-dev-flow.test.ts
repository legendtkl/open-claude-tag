import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { exec as execCb } from 'child_process';
import { promisify } from 'util';
import { ClaudeCodeAdapter } from '../claude-code-adapter.js';
import { createWorkspace } from '../workspace.js';
import { createWorktree, getWorktree, removeWorktree } from '../worktree-manager.js';
import { SELF_DEV_SYSTEM_PROMPT, getSelfDevSystemPrompt } from '../prompts/self-dev.js';
import { randomUUID } from 'crypto';
import type { RuntimeEvent } from '@open-tag/core-types';

const execAsync = promisify(execCb);

// ── Mock SDK ──
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { query as mockClaudeQuery } from '@anthropic-ai/claude-agent-sdk';

// ── Helpers ──
async function* fakeClaudeStream(messages: any[]): AsyncGenerator<any> {
  for (const msg of messages) yield msg;
}

function makeClaudeResult(sessionId: string, result: string) {
  return {
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    result,
    duration_ms: 2000,
    total_cost_usd: 0.005,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

function makeSpec(taskId: string, goal: string) {
  return {
    taskId,
    sessionId: 'test-session',
    taskType: 'self_dev' as const,
    goal,
    runtimeHint: 'claude_code' as const,
    constraints: {
      timeoutSec: 1800,
      approvalRequired: false,
      writeScope: [] as string[],
      networkPolicy: 'restricted' as const,
    },
    context: { systemPrompt: '', recentTurns: [] as unknown[] },
  };
}

async function collectEvents(gen: AsyncGenerator<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const events: RuntimeEvent[] = [];
  for await (const e of gen) events.push(e);
  return events;
}

// ── Tests ──
describe('Self-dev task flow', () => {
  let tempRepo: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempRepo = await mkdtemp(join(tmpdir(), 'selfdev-'));
    await execAsync(
      'git init && git config user.email "test@test.com" && git config user.name "Test" && git commit --allow-empty -m "init"',
      { cwd: tempRepo },
    );
    await execAsync('git branch -M main', { cwd: tempRepo });
  });

  afterEach(async () => {
    // Remove all worktrees first
    try {
      const { stdout } = await execAsync('git worktree list --porcelain', {
        cwd: tempRepo,
      });
      const paths = stdout
        .split('\n')
        .filter((l) => l.startsWith('worktree '))
        .map((l) => l.replace('worktree ', ''))
        .filter((p) => p !== tempRepo);
      for (const p of paths) {
        await execAsync(`git worktree remove "${p}" --force`, {
          cwd: tempRepo,
        }).catch(() => {});
      }
    } catch {
      // ignore
    }
    await rm(tempRepo, { recursive: true, force: true });
  });

  it('first self-dev turn: creates worktree + runs adapter with systemPrompt + yields PR URL', async () => {
    // 1. Create worktree (simulating what resolveDevWorkspace does)
    const sessionId = `session-${randomUUID().slice(0, 8)}-rest`;
    const wt = await createWorktree(sessionId, tempRepo);
    expect(existsSync(wt.worktreePath)).toBe(true);

    // 2. Mock SDK to return result with PR URL
    (mockClaudeQuery as any).mockReturnValue(
      fakeClaudeStream([
        makeClaudeResult(
          'sdk-dev-001',
          'Done! PR created: https://github.com/test/repo/pull/42\n\nAll tests passing.',
        ),
      ]),
    );

    // 3. Run adapter with worktree as cwd and systemPromptAppend
    const adapter = new ClaudeCodeAdapter({ baseUrl: 'http://proxy', authToken: 'key' });
    const spec = makeSpec('task-dev-1', '给 bot 加一个 /help 命令');
    const workspace = await createWorkspace(`session-dev-${randomUUID()}`);
    // Override workspace path to worktree (as worker does)
    workspace.workspacePath = wt.worktreePath;
    const handle = await adapter.prepare(spec, workspace);
    const events = await collectEvents(adapter.execute(handle, spec, SELF_DEV_SYSTEM_PROMPT));

    // 4. Verify SDK was called with correct options
    const call = (mockClaudeQuery as any).mock.calls[0][0];
    expect(call.options.cwd).toBe(wt.worktreePath);
    expect(call.options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: SELF_DEV_SYSTEM_PROMPT,
    });
    expect(call.options.settingSources).toEqual(['project']);
    // Dev tasks get maxTurns = 200 (extra turns for build+test+codex-review+fix+commit+PR)
    expect(call.options.maxTurns).toBe(200);

    // 5. Verify session_created event
    const sessionEvent = events.find((e) => e.type === 'session_created');
    expect(sessionEvent).toBeDefined();
    expect((sessionEvent as any).sdkSessionId).toBe('sdk-dev-001');

    // 6. Verify output contains PR URL (worker would regex-extract this)
    const completed = events.find((e) => e.type === 'completed');
    expect(completed).toBeDefined();
    const outputText = (completed as any).result.output.text;
    expect(outputText).toContain('https://github.com/test/repo/pull/42');

    // Simulate PR URL extraction (as worker does)
    const prMatch = outputText.match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/);
    expect(prMatch).not.toBeNull();
    expect(prMatch![0]).toBe('https://github.com/test/repo/pull/42');
  });

  it('second turn: resumes in same worktree + same SDK session', async () => {
    const sessionId = `session-${randomUUID().slice(0, 8)}-rest`;
    const wt = await createWorktree(sessionId, tempRepo);
    const adapter = new ClaudeCodeAdapter({ baseUrl: 'http://proxy', authToken: 'key' });
    const workspace = await createWorkspace(`session-dev-${randomUUID()}`);
    workspace.workspacePath = wt.worktreePath;

    // Turn 1: execute
    (mockClaudeQuery as any).mockReturnValue(
      fakeClaudeStream([
        makeClaudeResult('sdk-dev-002', 'PR: https://github.com/test/repo/pull/99'),
      ]),
    );
    const spec = makeSpec('task-dev-2', '加一个功能');
    const handle = await adapter.prepare(spec, workspace);
    await collectEvents(adapter.execute(handle, spec, SELF_DEV_SYSTEM_PROMPT));

    // Turn 2: resume in same worktree
    (mockClaudeQuery as any).mockReturnValue(
      fakeClaudeStream([makeClaudeResult('sdk-dev-002', 'Updated PR with error handling')]),
    );
    const resumeEvents = await collectEvents(
      adapter.resume('sdk-dev-002', '把错误处理也加上', workspace, SELF_DEV_SYSTEM_PROMPT),
    );

    // Verify resume used same cwd and session ID
    const resumeCall = (mockClaudeQuery as any).mock.calls[1][0];
    expect(resumeCall.options.resume).toBe('sdk-dev-002');
    expect(resumeCall.options.cwd).toBe(wt.worktreePath);
    expect(resumeCall.options.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: SELF_DEV_SYSTEM_PROMPT,
    });

    const completed = resumeEvents.find((e) => e.type === 'completed');
    expect((completed as any).result.output.text).toBe('Updated PR with error handling');
  });

  it('Claude self-dev prompt contains codex review step', () => {
    const prompt = getSelfDevSystemPrompt('claude_code');
    expect(prompt).toContain('codex --full-auto');
    expect(prompt).toContain('git diff');
    expect(prompt).toContain('critical / major');
  });

  it('Claude self-dev prompt triggers Copilot review via background review request polling service', () => {
    const prompt = getSelfDevSystemPrompt('claude_code');
    expect(prompt).toContain('@copilot review');
    expect(prompt).toContain('review request polling service');
    expect(prompt).toContain('gh pr comment $PR_NUM --body');
    expect(prompt).not.toContain('seq 1 24');
    expect(prompt).not.toContain('sleep 25');
  });

  it('Claude self-dev prompt does not require a manual Copilot follow-up comment', () => {
    const prompt = getSelfDevSystemPrompt('claude_code');
    expect(prompt).toContain('gh pr comment $PR_NUM --body');
    expect(prompt).not.toContain('List of issues fixed');
    expect(prompt).not.toContain('Minor issues acknowledged but not addressed');
  });

  it('Claude self-dev prompt includes PR submission and merge prompt', () => {
    const prompt = getSelfDevSystemPrompt('claude_code');
    expect(prompt).toContain('gh pr create');
    expect(prompt).toContain('PR: <url>');
    expect(prompt).toContain('/merge-pr');
  });

  it('Codex self-dev prompt requires an independent review agent', () => {
    const prompt = getSelfDevSystemPrompt('codex');
    expect(prompt).toContain('spawn an independent review agent');
    expect(prompt).toContain('main implementation thread cannot treat its own self-check as the final review');
    expect(prompt).toContain('critical / major / minor');
    expect(prompt).not.toContain('codex --full-auto');
  });

  it('an unknown runtime falls through to the Claude self-dev appendix', () => {
    // After the coco runtime was removed, any non-codex runtime (including a
    // legacy persisted value) resolves to the Claude appendix, never throwing.
    const prompt = getSelfDevSystemPrompt('coco');
    expect(prompt).toBe(getSelfDevSystemPrompt('claude_code'));
    expect(prompt).not.toContain('Coco Runtime Appendix');
    // Still carries the shared self-dev workflow.
    expect(prompt).toContain('expected files, modules, or workflow layers to update');
  });

  it('self-dev prompt requires a technical implementation plan in the first confirmation reply', () => {
    const prompt = getSelfDevSystemPrompt('codex');
    expect(prompt).toContain('technical implementation plan');
  });

  it('self-dev prompt defines the required technical plan content', () => {
    const prompt = getSelfDevSystemPrompt('codex');
    expect(prompt).toContain('expected code touch points');
    expect(prompt).toContain('expected code or test changes');
    expect(prompt).toContain('notable risks or trade-offs');
  });

  it('shared self-dev prompt preserves technical plan guidance for both runtimes', () => {
    const claudePrompt = SELF_DEV_SYSTEM_PROMPT;
    const codexPrompt = getSelfDevSystemPrompt('codex');

    expect(claudePrompt).toContain('expected files, modules, or workflow layers to update');
    expect(claudePrompt).toContain('expected test coverage to add or adjust');
    expect(codexPrompt).toContain('expected files, modules, or workflow layers to update');
    expect(codexPrompt).toContain('expected test coverage to add or adjust');
  });

  it('self-dev prompt keeps the confirmation gate and records decisions as ADRs on demand', () => {
    const prompt = getSelfDevSystemPrompt('codex');
    // The confirmation gate still blocks progress until the combined content is accepted...
    expect(prompt).toContain('continue to implementation');
    expect(prompt).toContain('Do not start implementation until the user confirms or adjusts the combined confirmation content');
    // ...and architectural decisions are recorded as concise ADRs on demand (no spec-driven artifacts).
    expect(prompt).toContain('Record real architectural decisions as a concise ADR');
    expect(prompt).toContain('doc/decisions/');
    expect(prompt).not.toContain('OpenSpec');
    expect(prompt).not.toContain('openspec');
  });

  it('worktree cleanup after branch merged to main', async () => {
    const sessionId = `session-${randomUUID().slice(0, 8)}-rest`;

    // 1. Create worktree
    const wt = await createWorktree(sessionId, tempRepo);
    expect(existsSync(wt.worktreePath)).toBe(true);

    // 2. Simulate work: commit something in the worktree
    await execAsync('touch feature.txt && git add . && git commit -m "feat: add feature"', {
      cwd: wt.worktreePath,
    });

    // 3. Simulate merge to main (as if GitHub PR was merged)
    await execAsync(`git merge ${wt.branchName}`, { cwd: tempRepo });

    // 4. Verify branch is now merged
    const { stdout } = await execAsync('git branch --merged main', { cwd: tempRepo });
    expect(stdout).toContain(wt.branchName);

    // 5. Clean up as the admin cleanup flow would do
    await removeWorktree(sessionId, tempRepo);
    expect(existsSync(wt.worktreePath)).toBe(false);

    // 6. Verify branch is also deleted
    const { stdout: branches } = await execAsync('git branch', { cwd: tempRepo });
    expect(branches).not.toContain(wt.branchName);

    // 7. getWorktree should return null
    const info = await getWorktree(sessionId, tempRepo);
    expect(info).toBeNull();
  });
});
