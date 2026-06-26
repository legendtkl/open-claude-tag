import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MEMORY_FILE_BYTES } from '../limits.js';
import { LocalAgentMemoryStore } from '../store.js';
import {
  discardAgentTaskMemory,
  finalizeAgentTaskMemory,
  prepareAgentTaskMemory,
  sweepAgentMemoryRuns,
} from '../index.js';

let home: string;
let store: LocalAgentMemoryStore;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-memory-test-'));
  store = new LocalAgentMemoryStore(home);
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('LocalAgentMemoryStore.prepare', () => {
  it('seeds MEMORY.md with the agent display name on first run', async () => {
    const prepared = await store.prepare('task-1', 'Reviewer-CC');
    expect(await readFile(join(home, 'MEMORY.md'), 'utf8')).toContain('# Reviewer-CC');
    expect(prepared.memoryMd).toContain('# Reviewer-CC');
    expect(prepared.noteFiles).toEqual([]);
  });

  it('does not overwrite an existing MEMORY.md when seeding', async () => {
    await writeFile(join(home, 'MEMORY.md'), '# Existing\n');
    const prepared = await store.prepare('task-1', 'NewName');
    expect(prepared.memoryMd).toBe('# Existing\n');
  });

  it('materializes an isolated checkout that includes notes', async () => {
    await writeFile(join(home, 'MEMORY.md'), '# A\n');
    await mkdir(join(home, 'notes'), { recursive: true });
    await writeFile(join(home, 'notes', 'work-log.md'), '- did things\n');

    const prepared = await store.prepare('task-1');
    expect(prepared.checkoutPath).toBe(join(home, 'runs', 'task-1'));
    expect(prepared.noteFiles).toEqual(['notes/work-log.md']);
    expect(await readFile(join(prepared.checkoutPath, 'notes', 'work-log.md'), 'utf8')).toBe(
      '- did things\n',
    );
  });

  it('keeps checkout edits away from the home until commit', async () => {
    await writeFile(join(home, 'MEMORY.md'), '# A\n');
    const prepared = await store.prepare('task-1');
    await writeFile(join(prepared.checkoutPath, 'MEMORY.md'), '# A\n- learned\n');
    expect(await readFile(join(home, 'MEMORY.md'), 'utf8')).toBe('# A\n');
  });
});

describe('LocalAgentMemoryStore.commit', () => {
  it('applies new notes and index edits, then removes the checkout', async () => {
    const prepared = await store.prepare('task-1', 'A');
    await writeFile(join(prepared.checkoutPath, 'MEMORY.md'), '# A\n\n## Key Knowledge\n- [log](notes/work-log.md)\n');
    await mkdir(join(prepared.checkoutPath, 'notes'), { recursive: true });
    await writeFile(join(prepared.checkoutPath, 'notes', 'work-log.md'), '- merged PR #1\n');

    const result = await store.commit('task-1');

    expect(result.applied.sort()).toEqual(['MEMORY.md', 'notes/work-log.md']);
    expect(result.conflicted).toEqual([]);
    expect(result.rejected).toEqual([]);
    expect(await readFile(join(home, 'notes', 'work-log.md'), 'utf8')).toBe('- merged PR #1\n');
    expect(await fileExists(join(home, 'runs', 'task-1'))).toBe(false);
  });

  it('returns an empty result for a missing checkout', async () => {
    const result = await store.commit('never-prepared');
    expect(result).toEqual({ applied: [], merged: [], conflicted: [], deleted: [], rejected: [] });
  });

  it('merges disjoint files from two parallel tasks', async () => {
    await store.prepare('task-a', 'A');
    const a = await store.prepare('task-a');
    const b = await store.prepare('task-b');

    await mkdir(join(a.checkoutPath, 'notes'), { recursive: true });
    await writeFile(join(a.checkoutPath, 'notes', 'from-a.md'), 'a knowledge\n');
    await mkdir(join(b.checkoutPath, 'notes'), { recursive: true });
    await writeFile(join(b.checkoutPath, 'notes', 'from-b.md'), 'b knowledge\n');

    const resultA = await store.commit('task-a');
    const resultB = await store.commit('task-b');

    expect(resultA.applied).toContain('notes/from-a.md');
    expect(resultB.applied).toContain('notes/from-b.md');
    expect(await fileExists(join(home, 'notes', 'from-a.md'))).toBe(true);
    expect(await fileExists(join(home, 'notes', 'from-b.md'))).toBe(true);
  });

  it('three-way merges concurrent edits to different MEMORY.md sections', async () => {
    const base = ['# A', '', '## Section One', '- one', '', '## Section Two', '- two', ''].join('\n');
    await writeFile(join(home, 'MEMORY.md'), base);
    const a = await store.prepare('task-a');
    const b = await store.prepare('task-b');

    await writeFile(join(a.checkoutPath, 'MEMORY.md'), base.replace('- one', '- one\n- one.b (task a)'));
    await writeFile(join(b.checkoutPath, 'MEMORY.md'), base.replace('- two', '- two\n- two.b (task b)'));

    const resultA = await store.commit('task-a');
    const resultB = await store.commit('task-b');

    expect(resultA.applied).toContain('MEMORY.md');
    expect(resultB.merged).toContain('MEMORY.md');
    const finalIndex = await readFile(join(home, 'MEMORY.md'), 'utf8');
    expect(finalIndex).toContain('- one.b (task a)');
    expect(finalIndex).toContain('- two.b (task b)');
  });

  it('keeps the committed version on conflict and preserves the loser', async () => {
    const base = '# A\n\n## Active\n- idle\n';
    await writeFile(join(home, 'MEMORY.md'), base);
    const a = await store.prepare('task-a');
    const b = await store.prepare('task-b');

    await writeFile(join(a.checkoutPath, 'MEMORY.md'), base.replace('- idle', '- working on a'));
    await writeFile(join(b.checkoutPath, 'MEMORY.md'), base.replace('- idle', '- working on b'));

    await store.commit('task-a');
    const resultB = await store.commit('task-b');

    expect(resultB.conflicted).toContain('MEMORY.md');
    expect(await readFile(join(home, 'MEMORY.md'), 'utf8')).toContain('- working on a');
    const conflictFiles = await readdir(join(home, '.conflicts'));
    expect(conflictFiles.some((name) => name.startsWith('task-b-'))).toBe(true);
    expect(
      await readFile(join(home, '.conflicts', 'task-b-MEMORY.md'), 'utf8'),
    ).toContain('- working on b');
  });

  it('absorbs direct edits to the home made while a task is running', async () => {
    const base = ['# A', '', '## One', '- one', '', '## Two', '- two', ''].join('\n');
    await writeFile(join(home, 'MEMORY.md'), base);
    const prepared = await store.prepare('task-1');

    // Simulate a generic-mode run (cwd == home) editing the canonical copy directly.
    await writeFile(join(home, 'MEMORY.md'), base.replace('- one', '- one\n- direct edit'));
    await writeFile(join(prepared.checkoutPath, 'MEMORY.md'), base.replace('- two', '- two\n- checkout edit'));

    const result = await store.commit('task-1');
    expect(result.merged).toContain('MEMORY.md');
    const finalIndex = await readFile(join(home, 'MEMORY.md'), 'utf8');
    expect(finalIndex).toContain('- direct edit');
    expect(finalIndex).toContain('- checkout edit');
  });

  it('rejects symlinked note files', async () => {
    await writeFile(join(home, 'secret.txt'), 'token=hunter2\n');
    const prepared = await store.prepare('task-1', 'A');
    await mkdir(join(prepared.checkoutPath, 'notes'), { recursive: true });
    await symlink(join(home, 'secret.txt'), join(prepared.checkoutPath, 'notes', 'sneaky.md'));

    const result = await store.commit('task-1');
    expect(result.rejected).toContainEqual({ path: 'notes/sneaky.md', reason: 'not-regular-file' });
    expect(await fileExists(join(home, 'notes', 'sneaky.md'))).toBe(false);
  });

  it('ignores files outside the memory model (non-md, internal manifests)', async () => {
    const prepared = await store.prepare('task-1', 'A');
    await mkdir(join(prepared.checkoutPath, 'notes'), { recursive: true });
    await writeFile(join(prepared.checkoutPath, 'notes', 'scratch.txt'), 'not memory\n');
    await writeFile(join(prepared.checkoutPath, 'evil.md'), 'top-level md outside model\n');

    const result = await store.commit('task-1');
    expect(result.applied).toEqual([]);
    expect(await fileExists(join(home, 'notes', 'scratch.txt'))).toBe(false);
    expect(await fileExists(join(home, 'evil.md'))).toBe(false);
  });

  it('rejects files containing sensitive content without touching the home', async () => {
    const prepared = await store.prepare('task-1', 'A');
    await mkdir(join(prepared.checkoutPath, 'notes'), { recursive: true });
    await writeFile(
      join(prepared.checkoutPath, 'notes', 'creds.md'),
      `api_key=sk-${'a'.repeat(32)}\n`,
    );

    const result = await store.commit('task-1');
    expect(result.rejected).toContainEqual({ path: 'notes/creds.md', reason: 'sensitive' });
    expect(await fileExists(join(home, 'notes', 'creds.md'))).toBe(false);
  });

  it('rejects oversize files', async () => {
    const prepared = await store.prepare('task-1', 'A');
    await mkdir(join(prepared.checkoutPath, 'notes'), { recursive: true });
    await writeFile(
      join(prepared.checkoutPath, 'notes', 'huge.md'),
      'x'.repeat(MAX_MEMORY_FILE_BYTES + 1),
    );

    const result = await store.commit('task-1');
    expect(result.rejected).toContainEqual({ path: 'notes/huge.md', reason: 'oversize' });
  });

  it('rejects writes that would overflow the per-agent quota', async () => {
    const prepared = await store.prepare('task-1', 'A');
    await mkdir(join(prepared.checkoutPath, 'notes'), { recursive: true });
    // 5 files x ~62KB of ordinary prose = ~310KB > 256KB total quota
    // (each file stays under the 64KB per-file cap).
    const prose = 'memory line with ordinary words\n'.repeat(1980);
    for (let i = 0; i < 5; i++) {
      await writeFile(join(prepared.checkoutPath, 'notes', `big-${i}.md`), prose);
    }

    const result = await store.commit('task-1');
    const quotaRejected = result.rejected.filter((entry) => entry.reason === 'quota');
    expect(quotaRejected.length).toBeGreaterThan(0);
    expect(result.applied.length + quotaRejected.length).toBe(5);
  });

  it('deletes a note the task deleted when nothing else changed it', async () => {
    await mkdir(join(home, 'notes'), { recursive: true });
    await writeFile(join(home, 'notes', 'obsolete.md'), 'old\n');
    const prepared = await store.prepare('task-1', 'A');
    await rm(join(prepared.checkoutPath, 'notes', 'obsolete.md'));

    const result = await store.commit('task-1');
    expect(result.deleted).toEqual(['notes/obsolete.md']);
    expect(await fileExists(join(home, 'notes', 'obsolete.md'))).toBe(false);
  });

  it('keeps a concurrently-modified note that the task deleted', async () => {
    await mkdir(join(home, 'notes'), { recursive: true });
    await writeFile(join(home, 'notes', 'shared.md'), 'v1\n');
    const prepared = await store.prepare('task-1', 'A');
    await writeFile(join(home, 'notes', 'shared.md'), 'v2 (concurrent)\n');
    await rm(join(prepared.checkoutPath, 'notes', 'shared.md'));

    const result = await store.commit('task-1');
    expect(result.deleted).toEqual([]);
    expect(result.conflicted).toContain('notes/shared.md');
    expect(await readFile(join(home, 'notes', 'shared.md'), 'utf8')).toBe('v2 (concurrent)\n');
  });
});

describe('janitor and discard', () => {
  it('discard drops the checkout without committing', async () => {
    const prepared = await store.prepare('task-1', 'A');
    await writeFile(join(prepared.checkoutPath, 'MEMORY.md'), '# changed\n');
    await store.discard('task-1');
    expect(await fileExists(join(home, 'runs', 'task-1'))).toBe(false);
    expect(await readFile(join(home, 'MEMORY.md'), 'utf8')).not.toContain('# changed');
  });

  it('sweepStaleRuns removes only checkouts older than the TTL', async () => {
    await store.prepare('task-old', 'A');
    await store.prepare('task-fresh', 'A');
    const oldDir = join(home, 'runs', 'task-old');
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await utimes(oldDir, past, past);

    const removed = await store.sweepStaleRuns(24 * 60 * 60 * 1000);
    expect(removed).toEqual(['task-old']);
    expect(await fileExists(join(home, 'runs', 'task-fresh'))).toBe(true);
  });
});

describe('worker facade', () => {
  it('prepare/finalize round-trip persists agent edits', async () => {
    const prepared = await prepareAgentTaskMemory({
      homeDir: home,
      taskId: 'task-1',
      displayName: 'Cindy',
    });
    expect(prepared.promptSection).toContain('<agent_memory>');
    expect(prepared.promptSection).toContain('# Cindy');
    expect(prepared.promptSection).toContain(prepared.checkoutPath);

    await writeFile(join(prepared.checkoutPath, 'MEMORY.md'), '# Cindy\n\n## Role\nOnboarding lead.\n');
    const result = await finalizeAgentTaskMemory({ homeDir: home, taskId: 'task-1' });
    expect(result.applied).toContain('MEMORY.md');
    expect(await readFile(join(home, 'MEMORY.md'), 'utf8')).toContain('Onboarding lead.');
  });

  it('discardAgentTaskMemory drops edits', async () => {
    const prepared = await prepareAgentTaskMemory({ homeDir: home, taskId: 'task-2' });
    await writeFile(join(prepared.checkoutPath, 'MEMORY.md'), '# discarded\n');
    await discardAgentTaskMemory({ homeDir: home, taskId: 'task-2' });
    expect(await readFile(join(home, 'MEMORY.md'), 'utf8')).not.toContain('# discarded');
  });

  it('sweepAgentMemoryRuns sweeps across agent homes', async () => {
    const agentsRoot = await mkdtemp(join(tmpdir(), 'agents-root-'));
    try {
      const agentHome = join(agentsRoot, 'agent-1');
      const agentStore = new LocalAgentMemoryStore(agentHome);
      await agentStore.prepare('task-stale', 'A');
      const staleDir = join(agentHome, 'runs', 'task-stale');
      const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
      await utimes(staleDir, past, past);

      const removed = await sweepAgentMemoryRuns(agentsRoot, 24 * 60 * 60 * 1000);
      expect(removed).toEqual({ 'agent-1': ['task-stale'] });
    } finally {
      await rm(agentsRoot, { recursive: true, force: true });
    }
  });
});
