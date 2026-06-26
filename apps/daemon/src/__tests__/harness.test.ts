import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { createWorkspace } from '@open-tag/runtime-adapters';
import {
  pickWorkdir,
  materializeImages,
  applyWorkdirHints,
  prepareDispatch,
  runDispatch,
} from '../harness.js';
import { makeDispatchFrame } from './fixtures.js';
import { StubAdapter, stubRuntimeManager } from './stub-adapter.js';

describe('harness', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'daemon-harness-'));
    process.env.OPEN_TAG_HOME = home;
  });
  afterEach(async () => {
    delete process.env.OPEN_TAG_HOME;
    await rm(home, { recursive: true, force: true });
  });

  describe('pickWorkdir', () => {
    it('follows confirmed → adhoc → default precedence', () => {
      expect(
        pickWorkdir({ confirmedWorkDir: '/c', adhocWorkDir: '/a', defaultWorkDir: '/d' }),
      ).toBe('/c');
      expect(pickWorkdir({ adhocWorkDir: '/a', defaultWorkDir: '/d' })).toBe('/a');
      expect(pickWorkdir({ defaultWorkDir: '/d' })).toBe('/d');
      expect(pickWorkdir({})).toBeUndefined();
    });
  });

  describe('materializeImages', () => {
    it('writes inline base64 images into input dir and appends to TASK.md', async () => {
      const workspace = await createWorkspace('disp-img');
      const pngBytes = Buffer.from('hello-image');
      const paths = await materializeImages(
        [{ name: 'shot.png', base64: pngBytes.toString('base64') }],
        workspace,
      );
      expect(paths).toHaveLength(1);
      const files = await readdir(workspace.inputDir);
      expect(files).toContain('shot.png');
      const written = await readFile(join(workspace.inputDir, 'shot.png'));
      expect(written.equals(pngBytes)).toBe(true);
      const taskMd = await readFile(join(workspace.workspacePath, 'TASK.md'), 'utf8');
      expect(taskMd).toContain('Image:');
    });

    it('skips empty/invalid images without throwing', async () => {
      const workspace = await createWorkspace('disp-img2');
      const paths = await materializeImages([{ name: 'empty.png', base64: '' }], workspace);
      expect(paths).toHaveLength(0);
    });

    it('sanitizes inline image names so they cannot escape the input dir', async () => {
      const workspace = await createWorkspace('disp-img-traversal');
      const pngBytes = Buffer.from('hello-image');
      const paths = await materializeImages(
        [{ name: '../escape.png', base64: pngBytes.toString('base64') }],
        workspace,
      );

      expect(paths).toEqual([join(workspace.inputDir, 'escape.png')]);
      await expect(readFile(resolve(workspace.inputDir, '..', 'escape.png'))).rejects.toThrow();
      const written = await readFile(join(workspace.inputDir, 'escape.png'));
      expect(written.equals(pngBytes)).toBe(true);
    });

    it('is a no-op for no images', async () => {
      const workspace = await createWorkspace('disp-img3');
      expect(await materializeImages(undefined, workspace)).toEqual([]);
    });
  });

  describe('applyWorkdirHints', () => {
    it('leaves cwd unset when no workdir hint is provided', async () => {
      const workspace = await createWorkspace('disp-wd1');
      const resolved = await applyWorkdirHints('disp-wd1', {}, workspace);
      expect(resolved.cwd).toBeUndefined();
      expect(workspace.cwd).toBeUndefined();
      expect(resolved.worktreeCreated).toBe(false);
    });

    it('falls back to a stable per-agent home when only agentId is hinted', async () => {
      const workspace = await createWorkspace('disp-wd-agent');
      const resolved = await applyWorkdirHints(
        'disp-wd-agent',
        { agentId: 'agent-123' },
        workspace,
      );
      const expectedHome = join(home, 'agents', 'agent-123');
      expect(resolved.cwd).toBe(expectedHome);
      expect(workspace.cwd).toBe(expectedHome);
      expect(resolved.worktreeCreated).toBe(false);
      expect(resolved.readOnly).toBe(false);
      // The home is created on demand so the runtime can cwd into it.
      await expect(readdir(expectedHome)).resolves.toEqual([]);
    });

    it('prefers an explicit dir hint over the agent home', async () => {
      const target = await mkdtemp(join(tmpdir(), 'daemon-pref-'));
      const workspace = await createWorkspace('disp-wd-pref');
      const resolved = await applyWorkdirHints(
        'disp-wd-pref',
        { confirmedWorkDir: target, readOnly: true, agentId: 'agent-123' },
        workspace,
      );
      expect(resolved.cwd).toBe(target);
      await rm(target, { recursive: true, force: true });
    });

    it('runs read-only directly against the dir without a worktree', async () => {
      const target = await mkdtemp(join(tmpdir(), 'daemon-ro-'));
      const workspace = await createWorkspace('disp-wd2');
      const resolved = await applyWorkdirHints(
        'disp-wd2',
        { confirmedWorkDir: target, readOnly: true },
        workspace,
      );
      expect(resolved.readOnly).toBe(true);
      expect(resolved.worktreeCreated).toBe(false);
      expect(workspace.cwd).toBe(target);
      expect(workspace.readOnly).toBe(true);
      await rm(target, { recursive: true, force: true });
    });

    it('runs a write run in a non-git dir directly (no worktree)', async () => {
      const target = await mkdtemp(join(tmpdir(), 'daemon-wr-'));
      const workspace = await createWorkspace('disp-wd3');
      const resolved = await applyWorkdirHints(
        'disp-wd3',
        { adhocWorkDir: target },
        workspace,
      );
      // Non-git path falls back to the dir itself.
      expect(resolved.worktreeCreated).toBe(false);
      expect(workspace.cwd).toBe(target);
      expect(workspace.readOnly).toBe(false);
      await rm(target, { recursive: true, force: true });
    });
  });

  describe('prepareDispatch', () => {
    it('copies task dispatch runtime env into the runtime workspace', async () => {
      const prepared = await prepareDispatch(
        makeDispatchFrame({ runtimeEnv: { a: 'b' } }),
        stubRuntimeManager(new StubAdapter([])),
      );

      expect(prepared.workspace.runtimeEnv).toEqual({ a: 'b' });
    });

    it('passes materialized inline image paths into runtime execution', async () => {
      const adapter = new StubAdapter([{ type: 'completed', result: { taskId: 'task-1', status: 'completed', output: {} } } as never]);
      const prepared = await prepareDispatch(
        makeDispatchFrame({
          images: [{ name: 'history.png', base64: Buffer.from('history-image').toString('base64') }],
        }),
        stubRuntimeManager(adapter),
      );

      for await (const _event of runDispatch(prepared)) {
        // drain
      }

      expect(adapter.lastExecuteHandle?.imagePaths).toHaveLength(1);
      expect(adapter.lastExecuteHandle?.imagePaths?.[0]).toContain('history.png');
    });
  });
});
