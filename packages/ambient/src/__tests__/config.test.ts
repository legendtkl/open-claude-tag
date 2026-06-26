import { describe, expect, it } from 'vitest';
import { isAmbientEnabled, parseAmbientFlag } from '../config.js';

describe('isAmbientEnabled — default OFF', () => {
  it('is OFF with no/empty config', () => {
    expect(isAmbientEnabled()).toBe(false);
    expect(isAmbientEnabled(undefined)).toBe(false);
    expect(isAmbientEnabled(null)).toBe(false);
    expect(isAmbientEnabled({})).toBe(false);
  });

  it('stays OFF when the global flag is unset or false', () => {
    expect(isAmbientEnabled({ globalEnabled: false })).toBe(false);
  });

  it('enables only on an explicit per-channel opt-in', () => {
    expect(isAmbientEnabled({ channelEnabled: true })).toBe(true);
  });

  it('enables via the global flag when there is no channel override', () => {
    expect(isAmbientEnabled({ globalEnabled: true })).toBe(true);
  });

  it('an explicit channel opt-out overrides a global enable', () => {
    expect(isAmbientEnabled({ globalEnabled: true, channelEnabled: false })).toBe(false);
  });
});

describe('parseAmbientFlag — OPEN_TAG_AMBIENT', () => {
  it('parses truthy env strings (case-insensitive, trimmed)', () => {
    for (const v of ['1', 'true', 'TRUE', ' on ', 'Yes']) {
      expect(parseAmbientFlag(v)).toBe(true);
    }
  });

  it('defaults OFF for absent/empty/other values', () => {
    for (const v of [undefined, null, '', '0', 'false', 'off', 'maybe']) {
      expect(parseAmbientFlag(v)).toBe(false);
    }
  });
});
