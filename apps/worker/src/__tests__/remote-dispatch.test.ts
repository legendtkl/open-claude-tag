import { describe, expect, it, vi } from 'vitest';
import type { TaskSpec } from '@open-tag/core-types';
import type { MachineRow } from '../machine-routing.js';
import { agentSessionStates, sessions as sessionsTable } from '@open-tag/storage';
import {
  isMachineSwitch,
  loadStoredSdkSessionMachineId,
  buildRemoteAdapter,
  decideMachineDispatch,
  machineSupportsAgentHome,
  remoteAgentHomeDisplayPath,
} from '../remote-dispatch.js';
import type { GatewayDispatchPort } from '../daemon-gateway/dispatch-bridge.js';
import { DAEMON_FEATURE_AGENT_HOME, DAEMON_FEATURE_RUNTIME_ENV } from '@open-tag/daemon-protocol';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
const loggerArg = logger as never;

const gateway: GatewayDispatchPort = {
  isMachineOnline: () => true,
  registerDispatch: () => () => {},
  sendToMachine: () => ({ ok: true }),
};

function machineRow(overrides: Partial<MachineRow> = {}): MachineRow {
  return {
    id: 'm-1',
    tenantKey: 't',
    ownerOpenId: 'ou',
    name: 'laptop',
    secretHash: 'h',
    status: 'online',
    capabilities: { runtimes: ['claude_code', 'codex'] },
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as MachineRow;
}

function specWithImage(): TaskSpec {
  return {
    taskId: '00000000-0000-0000-0000-000000000000',
    sessionId: '00000000-0000-0000-0000-000000000001',
    taskType: 'chat_reply',
    goal: 'g',
    runtimeHint: 'auto',
    constraints: {},
    context: {
      systemPrompt: '',
      recentTurns: [],
      imageAttachment: { imageKey: 'img_key', messageId: 'om_1' },
    },
  } as unknown as TaskSpec;
}

describe('isMachineSwitch (D15)', () => {
  it('local → remote is a switch', () => {
    expect(isMachineSwitch(null, 'm-1')).toBe(true);
  });
  it('remote → local is a switch', () => {
    expect(isMachineSwitch('m-1', null)).toBe(true);
  });
  it('same machine is not a switch', () => {
    expect(isMachineSwitch('m-1', 'm-1')).toBe(false);
  });
  it('different remote machines is a switch', () => {
    expect(isMachineSwitch('m-1', 'm-2')).toBe(true);
  });
  it('local → local (both null) is not a switch', () => {
    expect(isMachineSwitch(null, null)).toBe(false);
  });
});

describe('loadStoredSdkSessionMachineId (D15 substrate)', () => {
  /**
   * Table-routing fake: returns `agentRows` for selects on agent_session_states
   * and `sessionRows` for selects on sessions, so the test asserts the function
   * reads the persisted substrate column rather than the prior-task audit trail.
   */
  function dbReturning(input: {
    agentRows?: Array<{ machineId: string | null }>;
    sessionRows?: Array<{ machineId: string | null }>;
  }) {
    let table: unknown;
    const chain = {
      from(t: unknown) {
        table = t;
        return chain;
      },
      where: () => chain,
      orderBy: () => chain,
      async limit() {
        if (table === agentSessionStates) return input.agentRows ?? [];
        if (table === sessionsTable) return input.sessionRows ?? [];
        return [];
      },
    };
    return { select: vi.fn(() => chain) } as never;
  }

  it('reads the agent session state substrate when agentId is given', async () => {
    const id = await loadStoredSdkSessionMachineId(
      dbReturning({ agentRows: [{ machineId: 'm-agent' }] }),
      { sessionId: 's', agentId: 'agent-1' },
    );
    expect(id).toBe('m-agent');
  });

  it('returns null for a server-local agent turn (NULL substrate)', async () => {
    const id = await loadStoredSdkSessionMachineId(
      dbReturning({ agentRows: [{ machineId: null }] }),
      { sessionId: 's', agentId: 'agent-1' },
    );
    expect(id).toBeNull();
  });

  it('reads the session-level substrate for a legacy (no agent) turn', async () => {
    const id = await loadStoredSdkSessionMachineId(
      dbReturning({ sessionRows: [{ machineId: 'm-session' }] }),
      { sessionId: 's' },
    );
    expect(id).toBe('m-session');
  });

  it('returns null when no session row exists yet', async () => {
    const id = await loadStoredSdkSessionMachineId(dbReturning({ sessionRows: [] }), {
      sessionId: 's',
    });
    expect(id).toBeNull();
  });
});

describe('decideMachineDispatch — local/remote/fail taxonomy (D8, R2-3)', () => {
  it('resolved machine + gateway up → remote dispatch', () => {
    const machine = machineRow();
    const decision = decideMachineDispatch({ machine }, true);
    expect(decision.kind).toBe('remote');
    if (decision.kind === 'remote') expect(decision.machine).toBe(machine);
  });

  it('resolved machine + gateway down → fail fast (no silent local)', () => {
    const decision = decideMachineDispatch({ machine: machineRow({ name: 'laptop' }) }, false);
    expect(decision.kind).toBe('fail-fast');
    if (decision.kind === 'fail-fast') {
      expect(decision.message).toMatch(/daemon gateway is not running/);
      expect(decision.message).toContain('laptop');
    }
  });

  it('resolved machine + gateway up + no live socket → fail fast with offline copy', () => {
    const decision = decideMachineDispatch(
      { machine: machineRow({ name: 'offline-laptop', status: 'offline' }) },
      true,
      false,
    );

    expect(decision.kind).toBe('fail-fast');
    if (decision.kind === 'fail-fast') {
      expect(decision.message).toContain('Machine "offline-laptop" is offline');
      expect(decision.message).toContain('@open-tag/daemon@latest start --background');
    }
  });

  // ── Server-local: only self_dev and no_binding (current, correct behavior) ──
  it('no machine, reason self_dev → server-local', () => {
    expect(decideMachineDispatch({ machine: null, reason: 'self_dev' }, true)).toEqual({
      kind: 'server-local',
    });
  });

  it('no machine, reason no_binding → server-local', () => {
    expect(decideMachineDispatch({ machine: null, reason: 'no_binding' }, true)).toEqual({
      kind: 'server-local',
    });
  });

  // ── The R2-3 regression: invalid bindings must FAIL FAST, not run local ──
  it.each(['not_found', 'revoked', 'owner_mismatch'] as const)(
    'no machine, reason %s → fail fast (never server-local, D8)',
    (reason) => {
      const decision = decideMachineDispatch({ machine: null, reason }, true);
      expect(decision.kind).toBe('fail-fast');
      if (decision.kind === 'fail-fast') {
        // The card copy names the reason so the user knows what to fix.
        expect(decision.message).toContain(reason);
        expect(decision.message).toMatch(/admin console|rebind/);
      }
    },
  );

  it('invalid binding fails fast even when the gateway is up', () => {
    // The gateway being available must not rescue an invalid binding into local.
    const decision = decideMachineDispatch({ machine: null, reason: 'revoked' }, true);
    expect(decision.kind).toBe('fail-fast');
  });
});

describe('buildRemoteAdapter — capability check + image inlining (D11)', () => {
  it('fails when the machine does not support the runtime', async () => {
    const result = await buildRemoteAdapter({
      gateway,
      machine: machineRow({ capabilities: { runtimes: ['codex'] } }),
      runtime: 'claude_code',
      workdirHints: {},
      taskSpec: specWithImage(),
      logger: loggerArg,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/cannot run the "claude_code" runtime/);
  });

  it('fails closed when the machine advertises no known runtime (empty after filtering)', async () => {
    // A daemon advertising only unknown/legacy runtimes (e.g. a pre-removal `coco`)
    // normalizes to an empty known-runtime list; that must NOT read as unrestricted.
    const result = await buildRemoteAdapter({
      gateway,
      machine: machineRow({ capabilities: { runtimes: [] } }),
      runtime: 'claude_code',
      workdirHints: {},
      taskSpec: specWithImage(),
      logger: loggerArg,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/supported: none/);
  });

  it('fails fast when runtime env is configured but the daemon lacks runtime_env support', async () => {
    const result = await buildRemoteAdapter({
      gateway,
      machine: machineRow({ capabilities: { runtimes: ['claude_code', 'codex'] } }),
      runtime: 'claude_code',
      workdirHints: {},
      runtimeEnv: { SECRET_TOKEN: 'hidden' },
      taskSpec: specWithImage(),
      logger: loggerArg,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/does not advertise runtime env support/);
  });

  it('allows runtime env when the daemon advertises runtime_env support', async () => {
    const result = await buildRemoteAdapter({
      gateway,
      machine: machineRow({
        capabilities: {
          runtimes: ['claude_code', 'codex'],
          features: [DAEMON_FEATURE_RUNTIME_ENV],
        },
      }),
      runtime: 'claude_code',
      workdirHints: {},
      runtimeEnv: { SECRET_TOKEN: 'hidden' },
      taskSpec: specWithImage(),
      logger: loggerArg,
    });
    expect(result.ok).toBe(true);
  });

  it('inlines an image under the 10 MB cap as base64', async () => {
    const downloader = {
      downloadImage: vi.fn(async () => Buffer.from('hello-image')),
    };
    const result = await buildRemoteAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      taskSpec: specWithImage(),
      imageDownloader: downloader,
      logger: loggerArg,
    });
    expect(result.ok).toBe(true);
    expect(downloader.downloadImage).toHaveBeenCalledWith('om_1', 'img_key');
  });

  it('inlines contextual history images for remote dispatch', async () => {
    const downloader = {
      downloadImage: vi.fn(async () => Buffer.from('hello-image')),
    };
    const taskSpec = specWithImage();
    taskSpec.context.imageAttachments = [{ imageKey: 'img_history', messageId: 'om_history' }];

    const result = await buildRemoteAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      taskSpec,
      imageDownloader: downloader,
      logger: loggerArg,
    });

    expect(result.ok).toBe(true);
    expect(downloader.downloadImage).toHaveBeenCalledWith('om_1', 'img_key');
    expect(downloader.downloadImage).toHaveBeenCalledWith('om_history', 'img_history');
  });

  it('degrades to text-only when the image exceeds the cap', async () => {
    const big = Buffer.alloc(10 * 1024 * 1024 + 1);
    const downloader = { downloadImage: vi.fn(async () => big) };
    const result = await buildRemoteAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      taskSpec: specWithImage(),
      imageDownloader: downloader,
      logger: loggerArg,
    });
    expect(result.ok).toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('caps the number of images downloaded for remote dispatch', async () => {
    const downloader = {
      downloadImage: vi.fn(async () => Buffer.from('hello-image')),
    };
    const taskSpec = specWithImage();
    taskSpec.context.imageAttachments = Array.from({ length: 20 }, (_, index) => ({
      imageKey: `img_history_${index + 1}`,
      messageId: `om_history_${index + 1}`,
    }));

    const result = await buildRemoteAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      taskSpec,
      imageDownloader: downloader,
      logger: loggerArg,
    });

    expect(result.ok).toBe(true);
    expect(downloader.downloadImage).toHaveBeenCalledTimes(12);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ requestedImageCount: 21, includedImageCount: 12 }),
      'Remote dispatch image count exceeds cap, omitting extra images',
    );
  });

  it('keeps the current image and the newest history images when capping remote dispatch images', async () => {
    const downloader = {
      downloadImage: vi.fn(async () => Buffer.from('hello-image')),
    };
    const taskSpec = specWithImage();
    taskSpec.context.imageAttachments = Array.from({ length: 20 }, (_, index) => ({
      imageKey: `img_history_${index + 1}`,
      messageId: `om_history_${index + 1}`,
    }));

    const result = await buildRemoteAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      taskSpec,
      imageDownloader: downloader,
      logger: loggerArg,
    });

    expect(result.ok).toBe(true);
    expect(downloader.downloadImage).toHaveBeenCalledTimes(12);
    expect(downloader.downloadImage).toHaveBeenNthCalledWith(1, 'om_1', 'img_key');
    expect(downloader.downloadImage).toHaveBeenNthCalledWith(2, 'om_history_10', 'img_history_10');
    expect(downloader.downloadImage).toHaveBeenNthCalledWith(12, 'om_history_20', 'img_history_20');
    expect(downloader.downloadImage).not.toHaveBeenCalledWith('om_history_1', 'img_history_1');
  });

  it('caps aggregate image bytes for remote dispatch', async () => {
    const downloader = {
      downloadImage: vi.fn(async () => Buffer.alloc(8 * 1024 * 1024)),
    };
    const taskSpec = specWithImage();
    taskSpec.context.imageAttachments = [
      { imageKey: 'img_history_1', messageId: 'om_history_1' },
      { imageKey: 'img_history_2', messageId: 'om_history_2' },
    ];

    const result = await buildRemoteAdapter({
      gateway,
      machine: machineRow(),
      runtime: 'claude_code',
      workdirHints: {},
      taskSpec,
      imageDownloader: downloader,
      logger: loggerArg,
    });

    expect(result.ok).toBe(true);
    expect(downloader.downloadImage).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ imageKey: 'img_history_2', maxTotalBytes: 20 * 1024 * 1024 }),
      'Remote dispatch image total exceeds cap, omitting remaining image',
    );
  });
});

describe('machineSupportsAgentHome / remoteAgentHomeDisplayPath', () => {
  it('is true only when the daemon advertises the agent_home feature', () => {
    expect(
      machineSupportsAgentHome(
        machineRow({
          capabilities: { runtimes: ['codex'], features: [DAEMON_FEATURE_AGENT_HOME] },
        }),
      ),
    ).toBe(true);
    expect(
      machineSupportsAgentHome(
        machineRow({
          capabilities: { runtimes: ['codex'], features: [DAEMON_FEATURE_RUNTIME_ENV] },
        }),
      ),
    ).toBe(false);
    expect(machineSupportsAgentHome(machineRow({ capabilities: { runtimes: ['codex'] } }))).toBe(
      false,
    );
  });

  it('renders the machine-relative per-agent home path', () => {
    expect(remoteAgentHomeDisplayPath('agent-1')).toBe('~/.open-claude-tag/agents/agent-1');
  });
});
