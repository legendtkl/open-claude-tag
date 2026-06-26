import { describe, expect, it } from 'vitest';
import { decideWorkspaceMode } from '../workspace-mode.js';

const flags = (overrides: Partial<Parameters<typeof decideWorkspaceMode>[0]> = {}) => ({
  isPassthrough: false,
  isExternalProject: false,
  isSelfDev: false,
  isWrite: false,
  ...overrides,
});

describe('decideWorkspaceMode', () => {
  it('routes passthrough write requests to passthrough_write', () => {
    expect(decideWorkspaceMode(flags({ isPassthrough: true, isWrite: true }))).toBe(
      'passthrough_write',
    );
  });

  it('routes passthrough readonly requests to passthrough_readonly', () => {
    expect(decideWorkspaceMode(flags({ isPassthrough: true, isWrite: false }))).toBe(
      'passthrough_readonly',
    );
  });

  it('routes external project write requests to external_write', () => {
    expect(decideWorkspaceMode(flags({ isExternalProject: true, isWrite: true }))).toBe(
      'external_write',
    );
  });

  it('routes external project readonly requests to external_readonly', () => {
    expect(decideWorkspaceMode(flags({ isExternalProject: true, isWrite: false }))).toBe(
      'external_readonly',
    );
  });

  it('routes self-dev write requests to self_dev_write', () => {
    expect(decideWorkspaceMode(flags({ isSelfDev: true, isWrite: true }))).toBe('self_dev_write');
  });

  it('routes self-dev readonly requests to self_dev_readonly', () => {
    expect(decideWorkspaceMode(flags({ isSelfDev: true, isWrite: false }))).toBe(
      'self_dev_readonly',
    );
  });

  it('returns generic when no branch matches', () => {
    expect(decideWorkspaceMode(flags())).toBe('generic');
    expect(decideWorkspaceMode(flags({ isWrite: true }))).toBe('generic');
  });

  it('passthrough takes precedence over self_dev (mirrors caller short-circuit)', () => {
    // Caller derives isSelfDev with !isPassthrough already, but the helper is
    // robust to mistakenly-set flags by preferring the most specific branch.
    expect(
      decideWorkspaceMode(
        flags({ isPassthrough: true, isSelfDev: true, isWrite: true }),
      ),
    ).toBe('passthrough_write');
  });

  it('external_project takes precedence over self_dev when both flagged', () => {
    expect(
      decideWorkspaceMode(
        flags({ isExternalProject: true, isSelfDev: true, isWrite: false }),
      ),
    ).toBe('external_readonly');
  });
});
