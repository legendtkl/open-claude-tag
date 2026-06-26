import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackedCodexExec } from '../codex-adapter.js';
import { RuntimeExecutionRegistry } from '../runtime-execution-registry.js';

// Real-process tests for the hand-copied SDK exec layer. The adapter suite
// mocks the whole Codex SDK, so none of these paths (spawn options, abort
// wiring, cleanup) were ever executed — which is exactly how the dropped
// `signal` passthrough and missing finally-kill went unnoticed.

const scriptsDir = mkdtempSync(join(tmpdir(), 'tracked-codex-exec-'));

function writeScript(name: string, body: string): string {
  const path = join(scriptsDir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

// Emits a JSON line every 50ms forever (ignores stdin/args).
const STREAMING_SCRIPT = writeScript(
  'streaming.sh',
  `while true; do echo '{"type":"noop"}'; sleep 0.05; done`,
);
// Exits immediately without reading stdin.
const EXIT_FAST_SCRIPT = writeScript('exit-fast.sh', 'exit 0');
// Spawns a background descendant into the same (detached) process group and
// reports its pid as the first line, then streams forever.
const GRANDCHILD_SCRIPT = writeScript(
  'grandchild.sh',
  `( while true; do sleep 0.05; done ) &
echo "{\\"grandchildPid\\":$!}"
while true; do echo '{"type":"noop"}'; sleep 0.05; done`,
);

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function makeExec(executablePath: string, registry: RuntimeExecutionRegistry, executionId: string) {
  return new TrackedCodexExec({
    executablePath,
    executionId,
    executions: registry,
  });
}

async function waitForExit(child: ChildProcess, timeoutMs = 5000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('child did not exit within the wait window')),
      timeoutMs,
    );
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe('TrackedCodexExec real process lifecycle', () => {
  const uncaught: unknown[] = [];
  const onUncaught = (err: unknown) => {
    uncaught.push(err);
  };

  beforeEach(() => {
    uncaught.length = 0;
    process.on('uncaughtException', onUncaught);
  });

  afterEach(() => {
    process.removeListener('uncaughtException', onUncaught);
  });

  afterAll(() => {
    rmSync(scriptsDir, { recursive: true, force: true });
  });

  it('abort terminates the child process and surfaces the abort', async () => {
    const registry = new RuntimeExecutionRegistry({
      runtimeName: 'codex',
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const attachSpy = vi.spyOn(registry, 'attachChild');
    const abort = new AbortController();
    registry.start('exec-abort', abort);
    const exec = makeExec(STREAMING_SCRIPT, registry, 'exec-abort');

    const iterator = exec.run({ input: 'prompt', signal: abort.signal })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);

    const child = attachSpy.mock.calls[0][1] as ChildProcess;
    abort.abort();

    await expect(
      (async () => {
        for (;;) {
          const next = await iterator.next();
          if (next.done) return;
        }
      })(),
    ).rejects.toThrow();
    await waitForExit(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('abort kills the whole detached process group, not just the direct child', async () => {
    const registry = new RuntimeExecutionRegistry({
      runtimeName: 'codex',
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const attachSpy = vi.spyOn(registry, 'attachChild');
    const abort = new AbortController();
    registry.start('exec-group', abort);
    const exec = makeExec(GRANDCHILD_SCRIPT, registry, 'exec-group');

    const iterator = exec.run({ input: 'prompt', signal: abort.signal })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);
    const grandchildPid = JSON.parse(first.value as string).grandchildPid as number;
    expect(isProcessAlive(grandchildPid)).toBe(true);

    const child = attachSpy.mock.calls[0][1] as ChildProcess;
    abort.abort();
    await iterator.next().catch(() => undefined);
    await waitForExit(child);

    await vi.waitFor(
      () => {
        expect(isProcessAlive(grandchildPid)).toBe(false);
      },
      { timeout: 5000 },
    );
  });

  it('early consumer break kills the child instead of orphaning it', async () => {
    const registry = new RuntimeExecutionRegistry({
      runtimeName: 'codex',
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    const attachSpy = vi.spyOn(registry, 'attachChild');
    registry.start('exec-break', new AbortController());
    const exec = makeExec(STREAMING_SCRIPT, registry, 'exec-break');

    const iterator = exec.run({ input: 'prompt' })[Symbol.asyncIterator]();
    const first = await iterator.next();
    expect(first.done).toBe(false);

    const child = attachSpy.mock.calls[0][1] as ChildProcess;
    await iterator.return?.(undefined);

    await waitForExit(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('contains stdin write failures when the child exits without reading', async () => {
    const registry = new RuntimeExecutionRegistry({
      runtimeName: 'codex',
      logger: { info: vi.fn(), warn: vi.fn() },
    });
    registry.start('exec-epipe', new AbortController());
    const exec = makeExec(EXIT_FAST_SCRIPT, registry, 'exec-epipe');

    // Large input forces a backpressured write that hits EPIPE once the child
    // exits without draining stdin.
    const input = 'x'.repeat(1024 * 1024);
    const lines: string[] = [];
    try {
      for await (const line of exec.run({ input })) {
        lines.push(line);
      }
    } catch {
      // A nonzero-exit error is acceptable; an uncaught stream error is not.
    }

    // Give any pending stream error events a tick to surface.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(uncaught).toHaveLength(0);
  });
});
