import type {
  RuntimeAdapter,
  RuntimeDescriptor,
  RuntimeHandle,
  WorkspaceContext,
  HealthStatus,
  RuntimeCancelOutcome,
  RuntimeManager,
} from '@open-tag/runtime-adapters';
import type { TaskSpec, RuntimeEvent } from '@open-tag/core-types';

/**
 * Scriptable stub `RuntimeAdapter` for harness/dispatch tests. It yields a
 * caller-provided sequence of events for `execute`/`resume`, records which
 * methods were called, and supports a controllable async stream so tests can
 * interleave cancellation and disconnects.
 */
export class StubAdapter implements RuntimeAdapter {
  prepareCalls = 0;
  executeCalls = 0;
  resumeCalls = 0;
  cancelCalls: Array<{ executionId: string; force?: boolean }> = [];
  lastResumeSdkSessionId?: string;
  lastExecuteHandle?: RuntimeHandle;
  lastResumeOptions?: { imagePaths?: string[]; taskId?: string; executionId?: string };

  constructor(
    private readonly script: RuntimeEvent[],
    private readonly opts: { adapterName?: string; supportsResume?: boolean; gate?: Promise<void> } = {},
  ) {}

  name(): string {
    return this.opts.adapterName ?? 'claude_code';
  }

  descriptor(): RuntimeDescriptor {
    return {
      id: this.name().replace(/_/g, '-'),
      displayName: this.name(),
      capabilities: {
        resume: this.supportsResume(),
        enforcesReadOnly: false,
        interactivePermission: false,
        sandboxModes: ['danger-full-access'],
        imageInput: 'none',
        modelSelection: false,
      },
      credentialEnv: [],
    };
  }

  async prepare(spec: TaskSpec, workspace: WorkspaceContext): Promise<RuntimeHandle> {
    this.prepareCalls++;
    return {
      executionId: spec.taskId,
      workspacePath: workspace.workspacePath,
      cwd: workspace.cwd ?? workspace.workspacePath,
      readOnly: Boolean(workspace.readOnly),
    };
  }

  async *execute(handle: RuntimeHandle): AsyncGenerator<RuntimeEvent> {
    this.executeCalls++;
    this.lastExecuteHandle = handle;
    if (this.opts.gate) await this.opts.gate;
    for (const event of this.script) {
      yield event;
    }
  }

  async *resume(
    sdkSessionId: string,
    _prompt: string,
    _workspace: WorkspaceContext,
    _systemPromptAppend?: string,
    options?: { imagePaths?: string[]; taskId?: string; executionId?: string },
  ): AsyncGenerator<RuntimeEvent> {
    this.resumeCalls++;
    this.lastResumeSdkSessionId = sdkSessionId;
    this.lastResumeOptions = options;
    if (this.opts.gate) await this.opts.gate;
    for (const event of this.script) {
      yield event;
    }
  }

  async cancel(executionId: string, options?: { force?: boolean }): Promise<RuntimeCancelOutcome> {
    this.cancelCalls.push({ executionId, force: options?.force });
    return 'termination_started';
  }

  async collectArtifacts(): Promise<[]> {
    return [];
  }

  async healthcheck(): Promise<HealthStatus> {
    return { healthy: true, name: this.name(), lastCheckedAt: new Date() };
  }

  supportsResume(): boolean {
    return this.opts.supportsResume ?? true;
  }
}

/** Minimal `RuntimeManager` stand-in exposing only what DispatchManager uses. */
export function stubRuntimeManager(adapter: RuntimeAdapter | undefined): RuntimeManager {
  return {
    getHealthy: () => adapter,
    cancel: async (executionId: string, options?: { force?: boolean }) => {
      if (adapter) return adapter.cancel(executionId, options);
      return 'no_active_execution';
    },
  } as unknown as RuntimeManager;
}

/** Records serialized frames sent on the sink, decoding them for assertions. */
export class RecordingSink {
  readonly sent: unknown[] = [];
  open = true;

  send(serialized: string): boolean {
    if (!this.open) return false;
    this.sent.push(JSON.parse(serialized));
    return true;
  }

  byType(type: string): unknown[] {
    return this.sent.filter((f) => (f as { type: string }).type === type);
  }
}
