import { execFile as execFileCb } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { promisify } from 'util';
import { createLogger } from '@open-tag/observability';

const execFileAsync = promisify(execFileCb);
const logger = createLogger('worktree-hooks');

export type WorktreeHookPhase = 'pre' | 'post';

export interface WorktreeHookContext {
  sourceRoot: string;
  worktreePath: string;
  sessionId: string;
  branchName: string | null;
}

const HOOK_DIR = '.open-claude-tag/worktree-hooks';
const HOOK_TIMEOUT_MS = 60_000;

function hookScriptPath(sourceRoot: string, phase: WorktreeHookPhase): string {
  return join(sourceRoot, HOOK_DIR, `${phase}.sh`);
}

/**
 * Run a worktree lifecycle hook.
 *
 * Looks up `<sourceRoot>/.open-claude-tag/worktree-hooks/{pre,post}.sh` and invokes
 * it via `bash` with cwd set to the worktree directory. If the script is
 * absent, this is a silent no-op.
 *
 * Failure semantics differ by phase:
 *  - `pre` rethrows, so callers can roll back the partially-created worktree.
 *  - `post` swallows errors and only warns, so cleanup never blocks.
 */
export async function runWorktreeHook(
  phase: WorktreeHookPhase,
  ctx: WorktreeHookContext,
): Promise<void> {
  const script = hookScriptPath(ctx.sourceRoot, phase);
  if (!existsSync(script)) return;

  const env = {
    ...process.env,
    WORKTREE_PATH: ctx.worktreePath,
    REPO_ROOT: ctx.sourceRoot,
    SESSION_ID: ctx.sessionId,
    BRANCH_NAME: ctx.branchName ?? '',
    WORKTREE_HOOK_PHASE: phase,
  };

  try {
    // Use execFile (no shell) so script paths containing shell metacharacters
    // — quotes, $, backticks, spaces — cannot be reinterpreted as shell syntax.
    // sourceRoot ultimately flows from user-supplied projectPath in the
    // external-project flow, so this is a real injection surface.
    const { stdout, stderr } = await execFileAsync('bash', [script], {
      cwd: ctx.worktreePath,
      env,
      timeout: HOOK_TIMEOUT_MS,
    });
    logger.info(
      { phase, script, sessionId: ctx.sessionId, stdout: stdout.trim(), stderr: stderr.trim() },
      'Worktree hook executed',
    );
  } catch (err) {
    if (phase === 'pre') {
      logger.error({ err, script, sessionId: ctx.sessionId }, 'pre worktree hook failed');
      throw new Error(`pre worktree hook failed: ${(err as Error).message}`, { cause: err });
    }
    logger.warn({ err, script, sessionId: ctx.sessionId }, 'post worktree hook failed; continuing');
  }
}
