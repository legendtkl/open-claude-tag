import { describe, expect, it } from 'vitest';
import { stableUuidFromKey } from '../ids.js';

describe('stableUuidFromKey', () => {
  it('is deterministic for the same key', () => {
    expect(stableUuidFromKey('task-job:abc:run')).toBe(stableUuidFromKey('task-job:abc:run'));
  });

  it('differs for different keys', () => {
    expect(stableUuidFromKey('a')).not.toBe(stableUuidFromKey('b'));
  });

  it('produces an RFC-4122-shaped uuid (version + variant nibbles)', () => {
    const id = stableUuidFromKey('shape-check');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
