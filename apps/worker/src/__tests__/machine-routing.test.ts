import { describe, expect, it } from 'vitest';
import {
  resolveTaskMachine,
  machineCandidateIds,
  isInvalidBindingReason,
  type MachineRow,
} from '../machine-routing.js';

const OWNER = 'ou_owner';
const TENANT = 'tenant-a';

function machine(overrides: Partial<MachineRow> & { id: string }): MachineRow {
  return {
    id: overrides.id,
    tenantKey: overrides.tenantKey ?? TENANT,
    // Default to a legacy openId-owned machine; tests opt into console ownership
    // by passing `ownerOpenId: null` + `platformOwnerId`. Use `in` so an explicit
    // null override is honored (a `?? OWNER` fallback would clobber it).
    ownerOpenId: 'ownerOpenId' in overrides ? overrides.ownerOpenId! : OWNER,
    platformOwnerId: overrides.platformOwnerId ?? null,
    name: overrides.name ?? `machine-${overrides.id}`,
    secretHash: 'hash',
    status: overrides.status ?? 'online',
    capabilities: overrides.capabilities ?? { runtimes: ['claude_code', 'codex'] },
    lastSeenAt: overrides.lastSeenAt ?? new Date('2026-06-10T00:00:00.000Z'),
    createdAt: new Date('2026-06-01T00:00:00.000Z'),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
  } as MachineRow;
}

function byId(...rows: MachineRow[]): Map<string, MachineRow> {
  return new Map(rows.map((r) => [r.id, r]));
}

describe('resolveTaskMachine — precedence (D6/D7/D13)', () => {
  it('self_dev always resolves server-local regardless of bindings', () => {
    const result = resolveTaskMachine({
      taskType: 'self_dev',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      confirmedMachineId: 'm-confirmed',
      sessionBoundMachineId: 'm-session',
      chatDefaultMachineId: 'm-chat',
      machinesById: byId(machine({ id: 'm-confirmed' })),
    });
    expect(result.machine).toBeNull();
    expect(result.reason).toBe('self_dev');
  });

  it('explicit per-turn constraint wins over agent, session, and chat', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      confirmedMachineId: 'm-confirmed',
      agentMachineId: 'm-agent',
      sessionBoundMachineId: 'm-session',
      chatDefaultMachineId: 'm-chat',
      machinesById: byId(
        machine({ id: 'm-confirmed' }),
        machine({ id: 'm-agent' }),
        machine({ id: 'm-session' }),
        machine({ id: 'm-chat' }),
      ),
    });
    expect(result.machine?.id).toBe('m-confirmed');
  });

  // ── Agent machine binding precedence (design D-A8) ──
  it('agent machine wins over session and chat when no per-turn constraint', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      agentMachineId: 'm-agent',
      sessionBoundMachineId: 'm-session',
      chatDefaultMachineId: 'm-chat',
      machinesById: byId(
        machine({ id: 'm-agent' }),
        machine({ id: 'm-session' }),
        machine({ id: 'm-chat' }),
      ),
    });
    expect(result.machine?.id).toBe('m-agent');
  });

  it('agent machine null falls through to session binding', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      agentMachineId: null,
      sessionBoundMachineId: 'm-session',
      chatDefaultMachineId: 'm-chat',
      machinesById: byId(machine({ id: 'm-session' }), machine({ id: 'm-chat' })),
    });
    expect(result.machine?.id).toBe('m-session');
  });

  it('agent machine null falls through to chat default when no session binding', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      agentMachineId: null,
      chatDefaultMachineId: 'm-chat',
      machinesById: byId(machine({ id: 'm-chat' })),
    });
    expect(result.machine?.id).toBe('m-chat');
  });

  it('self_dev stays server-local even with an agent machine binding (D7)', () => {
    const result = resolveTaskMachine({
      taskType: 'self_dev',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      agentMachineId: 'm-agent',
      machinesById: byId(machine({ id: 'm-agent' })),
    });
    expect(result.machine).toBeNull();
    expect(result.reason).toBe('self_dev');
  });

  it('a revoked agent machine fails visibly and does not reroute to session/chat', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      agentMachineId: 'm-agent-revoked',
      sessionBoundMachineId: 'm-session',
      chatDefaultMachineId: 'm-chat',
      machinesById: byId(
        machine({ id: 'm-agent-revoked', status: 'revoked' }),
        machine({ id: 'm-session' }),
        machine({ id: 'm-chat' }),
      ),
    });
    expect(result.machine).toBeNull();
    expect(result.reason).toBe('revoked');
  });

  it('session binding wins over chat default when no per-turn constraint', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      sessionBoundMachineId: 'm-session',
      chatDefaultMachineId: 'm-chat',
      machinesById: byId(machine({ id: 'm-session' }), machine({ id: 'm-chat' })),
    });
    expect(result.machine?.id).toBe('m-session');
  });

  it('chat default applies when neither per-turn nor session binding set', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      chatDefaultMachineId: 'm-chat',
      machinesById: byId(machine({ id: 'm-chat' })),
    });
    expect(result.machine?.id).toBe('m-chat');
  });

  it('no binding resolves server-local', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      machinesById: byId(),
    });
    expect(result.machine).toBeNull();
    expect(result.reason).toBe('no_binding');
  });

  it('offline machine still resolves (dispatch fails fast later, D8)', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      sessionBoundMachineId: 'm-offline',
      machinesById: byId(machine({ id: 'm-offline', status: 'offline' })),
    });
    expect(result.machine?.id).toBe('m-offline');
  });

  it('revoked machine is excluded (server-local)', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      sessionBoundMachineId: 'm-revoked',
      machinesById: byId(machine({ id: 'm-revoked', status: 'revoked' })),
    });
    expect(result.machine).toBeNull();
    expect(result.reason).toBe('revoked');
  });

  it('rejects a machine owned by another user (D13)', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      sessionBoundMachineId: 'm-other',
      machinesById: byId(machine({ id: 'm-other', ownerOpenId: 'ou_someone_else' })),
    });
    expect(result.machine).toBeNull();
    expect(result.reason).toBe('owner_mismatch');
  });

  it('rejects a machine in a different tenant', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      sessionBoundMachineId: 'm-x',
      machinesById: byId(machine({ id: 'm-x', tenantKey: 'tenant-b' })),
    });
    expect(result.machine).toBeNull();
    expect(result.reason).toBe('owner_mismatch');
  });

  it('fails closed when the requester identity is unknown', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: null,
      tenantKey: TENANT,
      sessionBoundMachineId: 'm-session',
      machinesById: byId(machine({ id: 'm-session' })),
    });
    expect(result.machine).toBeNull();
    expect(result.reason).toBe('owner_mismatch');
  });

  it('an explicit choice that has no row does not fall through to the next level', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: OWNER,
      tenantKey: TENANT,
      confirmedMachineId: 'm-missing',
      sessionBoundMachineId: 'm-session',
      machinesById: byId(machine({ id: 'm-session' })),
    });
    expect(result.machine).toBeNull();
    expect(result.reason).toBe('not_found');
  });

  // ── Console-owned machines (design D-A7) ──
  // A machine paired + bound in the admin console carries `platformOwnerId` and no
  // `ownerOpenId`. The chat user just authors the task; the openId ownership gate
  // (D13) does NOT apply because the operator already authorized the binding.

  it('resolves a console-owned machine regardless of chat-user openId (D-A7)', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      // A different chat user @-mentions the bot; ownership is not their concern.
      ownerOpenId: 'ou_some_chat_user',
      tenantKey: TENANT,
      chatDefaultMachineId: 'm-console',
      machinesById: byId(
        machine({ id: 'm-console', ownerOpenId: null, platformOwnerId: 'pu-1' }),
      ),
    });
    expect(result.machine?.id).toBe('m-console');
    expect(result.reason).toBeUndefined();
  });

  it('resolves a console-owned machine even when the requester identity is unknown', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: null,
      tenantKey: TENANT,
      chatDefaultMachineId: 'm-console',
      machinesById: byId(
        machine({ id: 'm-console', ownerOpenId: null, platformOwnerId: 'pu-1' }),
      ),
    });
    expect(result.machine?.id).toBe('m-console');
  });

  it('still excludes a revoked console-owned machine', () => {
    const result = resolveTaskMachine({
      taskType: 'chat_reply',
      ownerOpenId: 'ou_anyone',
      tenantKey: TENANT,
      chatDefaultMachineId: 'm-console',
      machinesById: byId(
        machine({
          id: 'm-console',
          ownerOpenId: null,
          platformOwnerId: 'pu-1',
          status: 'revoked',
        }),
      ),
    });
    expect(result.machine).toBeNull();
    expect(result.reason).toBe('revoked');
  });
});

describe('isInvalidBindingReason (D8 fail-fast taxonomy)', () => {
  it('classifies explicit-but-invalid bindings as fail-fast', () => {
    expect(isInvalidBindingReason('not_found')).toBe(true);
    expect(isInvalidBindingReason('revoked')).toBe(true);
    expect(isInvalidBindingReason('owner_mismatch')).toBe(true);
  });

  it('classifies self_dev and no_binding as server-local (not invalid)', () => {
    expect(isInvalidBindingReason('self_dev')).toBe(false);
    expect(isInvalidBindingReason('no_binding')).toBe(false);
  });

  it('treats an undefined reason (a resolved machine) as not invalid', () => {
    expect(isInvalidBindingReason(undefined)).toBe(false);
  });
});

describe('machineCandidateIds', () => {
  it('returns distinct ids in precedence order including the agent machine (D-A8)', () => {
    expect(
      machineCandidateIds({
        taskType: 'chat_reply',
        confirmedMachineId: 'a',
        agentMachineId: 'c',
        sessionBoundMachineId: 'b',
        chatDefaultMachineId: 'a',
      }),
    ).toEqual(['a', 'c', 'b']);
  });

  it('returns nothing for self_dev', () => {
    expect(
      machineCandidateIds({
        taskType: 'self_dev',
        confirmedMachineId: 'a',
        agentMachineId: 'c',
        sessionBoundMachineId: 'b',
      }),
    ).toEqual([]);
  });
});
