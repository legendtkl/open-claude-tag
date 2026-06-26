import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, SUPPORTED_PROTOCOL_RANGE, isProtocolCompatible } from '../version.js';

describe('protocol version constants', () => {
  it('declares PROTOCOL_VERSION = 1', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });

  it('declares the supported range as [1, 1]', () => {
    expect(SUPPORTED_PROTOCOL_RANGE).toEqual({ min: 1, max: 1 });
  });

  it('the current protocol version is within the supported range', () => {
    expect(isProtocolCompatible(PROTOCOL_VERSION, SUPPORTED_PROTOCOL_RANGE)).toBe(true);
  });
});

describe('isProtocolCompatible matrix', () => {
  const cases: Array<{
    version: number;
    range: { min: number; max: number };
    expected: boolean;
    label: string;
  }> = [
    { version: 1, range: { min: 1, max: 1 }, expected: true, label: 'exact single-version match' },
    { version: 0, range: { min: 1, max: 1 }, expected: false, label: 'below min' },
    { version: 2, range: { min: 1, max: 1 }, expected: false, label: 'above max' },
    { version: 1, range: { min: 1, max: 3 }, expected: true, label: 'at the min of a wide range' },
    { version: 3, range: { min: 1, max: 3 }, expected: true, label: 'at the max of a wide range' },
    { version: 2, range: { min: 1, max: 3 }, expected: true, label: 'interior of a wide range' },
    { version: 4, range: { min: 1, max: 3 }, expected: false, label: 'just above a wide range' },
    { version: 1, range: { min: 5, max: 2 }, expected: false, label: 'inverted (malformed) range' },
  ];

  for (const { version, range, expected, label } of cases) {
    it(`${label}: v${version} in [${range.min},${range.max}] -> ${expected}`, () => {
      expect(isProtocolCompatible(version, range)).toBe(expected);
    });
  }
});
