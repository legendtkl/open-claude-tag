import { describe, expect, it, vi } from 'vitest';
import {
  type AgentCommandServices,
  handleAgentCommand,
} from '../agent-commands.js';

function makeServices(overrides: Partial<AgentCommandServices> = {}): AgentCommandServices {
  return {
    listAgents: vi.fn(async () => [
      {
        handle: 'open-claude-tag',
        displayName: 'OpenClaudeTag',
        visibility: 'public',
        status: 'active',
      },
    ]),
    getAgentInfo: vi.fn(async (handle: string) =>
      handle === 'open-claude-tag'
        ? {
            handle,
            displayName: 'OpenClaudeTag',
            description: 'Default assistant',
            visibility: 'public',
            status: 'active',
            profileName: 'open-claude-tag',
            boundAppId: 'cli_primary',
          }
        : null,
    ),
    syncAgents: vi.fn(async () => ({ scanned: 2, synced: [{ handle: 'open-claude-tag' }] })),
    bindBot: vi.fn(async (handle: string, appId: string) => ({
      ok: true,
      message: `Agent ${handle} bound to Feishu app ${appId}.`,
    })),
    unbindBot: vi.fn(async (handle: string) => ({
      ok: true,
      message: `Agent ${handle} bot binding disabled.`,
    })),
    setDefaultAgent: vi.fn(async (handle: string) => ({
      ok: true,
      message: `Default agent for this chat set to ${handle}.`,
    })),
    ...overrides,
  };
}

describe('handleAgentCommand', () => {
  it('lists agents', async () => {
    const services = makeServices();

    const result = await handleAgentCommand('list', { canManageAgents: false }, services);

    expect(result.mutated).toBe(false);
    expect(result.message).toContain('open-claude-tag');
  });

  it('shows agent info', async () => {
    const services = makeServices();

    const result = await handleAgentCommand('info open-claude-tag', { canManageAgents: false }, services);

    expect(result.message).toContain('Profile: open-claude-tag');
    expect(result.message).toContain('Feishu app: cli_primary');
  });

  it('syncs manifests when caller can manage agents', async () => {
    const services = makeServices();

    const result = await handleAgentCommand('sync', { canManageAgents: true }, services);

    expect(result.mutated).toBe(true);
    expect(result.message).toContain('2 manifest(s)');
    expect(services.syncAgents).toHaveBeenCalled();
  });

  it('binds and unbinds Feishu bots', async () => {
    const services = makeServices();

    const bind = await handleAgentCommand(
      'bind-bot open-claude-tag cli_primary',
      { canManageAgents: true },
      services,
    );
    const unbind = await handleAgentCommand(
      'unbind-bot open-claude-tag',
      { canManageAgents: true },
      services,
    );

    expect(bind.mutated).toBe(true);
    expect(unbind.mutated).toBe(true);
    expect(services.bindBot).toHaveBeenCalledWith('open-claude-tag', 'cli_primary');
    expect(services.unbindBot).toHaveBeenCalledWith('open-claude-tag');
  });

  it('sets a chat default agent', async () => {
    const services = makeServices();

    const result = await handleAgentCommand('default open-claude-tag', { canManageAgents: true }, services);

    expect(result.mutated).toBe(true);
    expect(services.setDefaultAgent).toHaveBeenCalledWith('open-claude-tag');
  });

  it('rejects mutating commands without manage permission', async () => {
    const services = makeServices();

    const result = await handleAgentCommand(
      'bind-bot open-claude-tag cli_primary',
      { canManageAgents: false },
      services,
    );

    expect(result.mutated).toBe(false);
    expect(result.message).toContain('Permission denied');
    expect(services.bindBot).not.toHaveBeenCalled();
  });

  it('returns help for unknown commands', async () => {
    const result = await handleAgentCommand('wat', { canManageAgents: false }, makeServices());

    expect(result.message).toContain('/agent list');
    expect(result.mutated).toBe(false);
  });
});
