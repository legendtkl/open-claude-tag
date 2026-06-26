import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { homedir } from 'os';
import { join } from 'path';
import { rm, stat } from 'fs/promises';
import {
  openClaudeTagHome,
  resolveAgentHomeDir,
  ensureAgentHomeDir,
  createWorkspace,
  cleanupWorkspace,
} from '../workspace.js';

const ENV_KEYS = ['OPEN_TAG_HOME', 'WORKSPACES_ROOT'] as const;

describe('workspace path helpers', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe('openClaudeTagHome', () => {
    it('defaults to ~/.open-claude-tag', () => {
      expect(openClaudeTagHome()).toBe(join(homedir(), '.open-claude-tag'));
    });

    it('honors OPEN_TAG_HOME when set', () => {
      process.env.OPEN_TAG_HOME = '/data/cc';
      expect(openClaudeTagHome()).toBe('/data/cc');
    });

    it('ignores blank OPEN_TAG_HOME', () => {
      process.env.OPEN_TAG_HOME = '   ';
      expect(openClaudeTagHome()).toBe(join(homedir(), '.open-claude-tag'));
    });
  });

  describe('resolveAgentHomeDir', () => {
    it('returns <home>/agents/<agentId>', () => {
      process.env.OPEN_TAG_HOME = '/data/cc';
      expect(resolveAgentHomeDir('d4f8e65d-c389')).toBe('/data/cc/agents/d4f8e65d-c389');
    });
  });

  describe('ensureAgentHomeDir', () => {
    it('creates the per-agent home directory and returns its path', async () => {
      const base = join(homedir(), '.open-claude-tag-test-' + process.pid);
      process.env.OPEN_TAG_HOME = base;
      const agentId = 'agent-ensure-test';
      try {
        const dir = await ensureAgentHomeDir(agentId);
        expect(dir).toBe(join(base, 'agents', agentId));
        const s = await stat(dir);
        expect(s.isDirectory()).toBe(true);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  });

  describe('createWorkspace scratch root', () => {
    it('creates the scratch workspace under the OpenClaudeTag home, not /tmp', async () => {
      const base = join(homedir(), '.open-claude-tag-ws-' + process.pid);
      process.env.OPEN_TAG_HOME = base;
      const runId = 'run-paths-test';
      try {
        const ws = await createWorkspace(runId);
        expect(ws.workspacePath).toBe(join(base, 'workspaces', runId));
        expect(ws.workspacePath).not.toContain('/tmp');
      } finally {
        await cleanupWorkspace(runId);
        await rm(base, { recursive: true, force: true });
      }
    });

    it('honors WORKSPACES_ROOT override', async () => {
      const base = join(homedir(), '.open-claude-tag-wsroot-' + process.pid);
      process.env.WORKSPACES_ROOT = base;
      const runId = 'run-override-test';
      try {
        const ws = await createWorkspace(runId);
        expect(ws.workspacePath).toBe(join(base, runId));
      } finally {
        await cleanupWorkspace(runId);
        await rm(base, { recursive: true, force: true });
      }
    });
  });
});
