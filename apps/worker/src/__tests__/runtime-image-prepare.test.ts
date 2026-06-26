import { describe, expect, it, vi } from 'vitest';
import { prepareResumeImagePaths } from '../runtime-image-prepare.js';
import type { RuntimeAdapter, WorkspaceContext } from '@open-tag/runtime-adapters';
import type { TaskSpec } from '@open-tag/core-types';

function makeSpec(
  imageAttachment?: TaskSpec['context']['imageAttachment'],
  imageAttachments?: TaskSpec['context']['imageAttachments'],
): TaskSpec {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    taskType: 'chat_reply',
    goal: 'analyze image',
    runtimeHint: 'codex',
    constraints: {
      timeoutSec: 30,
      approvalRequired: false,
      writeScope: [],
      networkPolicy: 'restricted',
    },
    context: { systemPrompt: '', recentTurns: [], imageAttachment, imageAttachments },
  };
}

function makeWorkspace(): WorkspaceContext {
  return {
    runId: 'run-1',
    workspacePath: '/tmp/open-claude-tag/run-1',
    inputDir: '/tmp/open-claude-tag/run-1/input',
    outputDir: '/tmp/open-claude-tag/run-1/output',
    repoDir: '/tmp/open-claude-tag/run-1/repo',
    artifactsDir: '/tmp/open-claude-tag/run-1/artifacts',
    logsDir: '/tmp/open-claude-tag/run-1/logs',
  };
}

describe('prepareResumeImagePaths', () => {
  it('skips adapter preparation when the resumed turn has no image attachment', async () => {
    const adapter = {
      prepare: vi.fn(),
    } as unknown as RuntimeAdapter;

    await expect(prepareResumeImagePaths(adapter, makeSpec(), makeWorkspace())).resolves.toEqual(
      [],
    );
    expect(adapter.prepare).not.toHaveBeenCalled();
  });

  it('prepares image paths for a resumed image turn', async () => {
    const workspace = makeWorkspace();
    const spec = makeSpec({ messageId: 'msg_1', imageKey: 'img_1' });
    const adapter = {
      prepare: vi.fn().mockResolvedValue({
        executionId: spec.taskId,
        workspacePath: workspace.workspacePath,
        cwd: workspace.workspacePath,
        readOnly: false,
        imagePaths: ['/tmp/open-claude-tag/run-1/image.png'],
      }),
    } as unknown as RuntimeAdapter;

    await expect(prepareResumeImagePaths(adapter, spec, workspace)).resolves.toEqual([
      '/tmp/open-claude-tag/run-1/image.png',
    ]);
    expect(adapter.prepare).toHaveBeenCalledWith(spec, workspace);
  });

  it('prepares image paths for contextual history images', async () => {
    const workspace = makeWorkspace();
    const spec = makeSpec(undefined, [{ messageId: 'msg_history', imageKey: 'img_history' }]);
    const adapter = {
      prepare: vi.fn().mockResolvedValue({
        executionId: spec.taskId,
        workspacePath: workspace.workspacePath,
        cwd: workspace.workspacePath,
        readOnly: false,
        imagePaths: ['/tmp/open-claude-tag/run-1/image-1.png'],
      }),
    } as unknown as RuntimeAdapter;

    await expect(prepareResumeImagePaths(adapter, spec, workspace)).resolves.toEqual([
      '/tmp/open-claude-tag/run-1/image-1.png',
    ]);
    expect(adapter.prepare).toHaveBeenCalledWith(spec, workspace);
  });
});
