import { describe, expect, it } from 'vitest';
import { createChannelRegistry } from '../registry.js';
import type { Channel, ChannelKind } from '../types.js';

function stubChannel(kind: ChannelKind): Channel {
  return {
    kind,
    capabilities: () => ({
      supportsCards: true,
      supportsStreamingEdit: true,
      supportsThreads: true,
      supportsReactions: true,
      supportsForms: true,
      supportsApprovalButtons: true,
      supportsAttachmentsIn: ['image', 'file'],
      supportsAttachmentsOut: ['image', 'file'],
      maxOutboundChars: 30000,
      maxOutboundElements: 200,
      maxUpdateRateHz: 5,
    }),
    start: async () => ({ stop: async () => {} }),
    normalize: () => null,
    extractAddressingSignals: () => [],
    send: async (to) => ({ kind, logicalMessageId: 'm1', revision: 0, physicalIds: ['p1'], native: to }),
    update: async (ref) => ref,
    uploadArtifact: async () => ({ type: 'file', ref: 'r1' }),
    fetchAttachment: async () => ({ path: '/tmp/x', name: 'x' }),
    resolveScope: (msg) => msg.scope,
    healthcheck: async () => ({ healthy: true }),
  };
}

describe('createChannelRegistry', () => {
  it('registers and resolves channels by kind', () => {
    const reg = createChannelRegistry();
    reg.register(stubChannel('lark'));
    reg.register(stubChannel('slack'));

    expect(reg.get('lark')?.kind).toBe('lark');
    expect(reg.get('slack')?.kind).toBe('slack');
    expect(reg.get('discord')).toBeUndefined();
    expect(reg.all().map((c) => c.kind).sort()).toEqual(['lark', 'slack']);
  });

  it('a later registration overrides the same kind', () => {
    const reg = createChannelRegistry();
    const first = stubChannel('lark');
    const second = stubChannel('lark');
    reg.register(first);
    reg.register(second);
    expect(reg.get('lark')).toBe(second);
    expect(reg.all()).toHaveLength(1);
  });
});
