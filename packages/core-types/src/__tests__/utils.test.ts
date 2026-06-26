import { describe, expect, it } from 'vitest';
import { errorMessage } from '../errors.js';
import { isObjectRecord } from '../guards.js';
import { truncateText } from '../text.js';

describe('isObjectRecord', () => {
  it('accepts plain objects', () => {
    expect(isObjectRecord({})).toBe(true);
    expect(isObjectRecord({ a: 1 })).toBe(true);
  });

  it('rejects arrays, null and primitives', () => {
    expect(isObjectRecord([])).toBe(false);
    expect(isObjectRecord(null)).toBe(false);
    expect(isObjectRecord('x')).toBe(false);
    expect(isObjectRecord(42)).toBe(false);
    expect(isObjectRecord(undefined)).toBe(false);
  });
});

describe('errorMessage', () => {
  it('returns the message for Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(errorMessage('plain')).toBe('plain');
    expect(errorMessage(42)).toBe('42');
    expect(errorMessage(undefined)).toBe('undefined');
  });
});

describe('truncateText', () => {
  it('returns values within the limit unchanged', () => {
    expect(truncateText('hello', 5)).toBe('hello');
    expect(truncateText('hi', 5)).toBe('hi');
  });

  it('cuts values beyond the limit', () => {
    expect(truncateText('hello world', 5)).toBe('hello');
  });

  it('appends the suffix only when truncating', () => {
    expect(truncateText('hello world', 5, { suffix: '...' })).toBe('hello...');
    expect(truncateText('hello', 5, { suffix: '...' })).toBe('hello');
  });

  it('right-trims the kept prefix when trimEnd is set', () => {
    expect(truncateText('hello   world', 7, { trimEnd: true })).toBe('hello');
    expect(truncateText('hello   world', 7, { trimEnd: true, suffix: '…' })).toBe('hello…');
  });

  it('keeps nothing for non-positive limits', () => {
    expect(truncateText('hello', 0, { suffix: '...' })).toBe('...');
    expect(truncateText('hello', -2)).toBe('');
  });
});
