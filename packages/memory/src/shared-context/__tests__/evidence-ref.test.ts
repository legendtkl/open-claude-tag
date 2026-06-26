import { describe, it, expect } from 'vitest';
import {
  parseEvidenceRef,
  assertCrossBoundaryPortable,
  isLocalPathLike,
  EvidenceRefError,
} from '../evidence-ref.js';

describe('isLocalPathLike', () => {
  it.each([
    ['/Users/me/repo/file.py', true],
    ['./relative/path', true],
    ['../up/path', true],
    ['~/home/path', true],
    ['C:\\Windows\\path', true],
    ['file:///tmp/x', true],
    ['lacks trailing comma', false],
    ['', false],
  ])('classifies %s as %s', (value, expected) => {
    expect(isLocalPathLike(value)).toBe(expected);
  });
});

describe('parseEvidenceRef', () => {
  it('parses an artifact ref', () => {
    expect(parseEvidenceRef({ kind: 'artifact', artifactId: 'a1' })).toEqual({
      kind: 'artifact',
      artifactId: 'a1',
    });
  });

  it('parses a git ref', () => {
    expect(parseEvidenceRef({ kind: 'git', gitBranch: 'fix/x', gitCommit: 'abc' })).toEqual({
      kind: 'git',
      gitBranch: 'fix/x',
      gitCommit: 'abc',
    });
  });

  it('parses an inline ref', () => {
    expect(parseEvidenceRef({ kind: 'inline', inline: 'evidence text' })).toEqual({
      kind: 'inline',
      inline: 'evidence text',
    });
  });

  it('rejects a bare local path string', () => {
    expect(() => parseEvidenceRef('/Users/me/repo/file.py')).toThrow(EvidenceRefError);
  });

  it('rejects a local-path-shaped object', () => {
    expect(() => parseEvidenceRef({ path: '/tmp/x' })).toThrow(/local path/);
    expect(() => parseEvidenceRef({ kind: 'local', localPath: '/tmp/x' })).toThrow(/local path/);
  });

  it('rejects an inline ref that is just a local path', () => {
    expect(() => parseEvidenceRef({ kind: 'inline', inline: '/tmp/x' })).toThrow(/portable/);
  });

  it('rejects missing / unknown / incomplete refs', () => {
    expect(() => parseEvidenceRef(null)).toThrow(/required/);
    expect(() => parseEvidenceRef({ kind: 'mystery' })).toThrow(/unknown/);
    expect(() => parseEvidenceRef({ kind: 'artifact' })).toThrow(/artifactId/);
    expect(() => parseEvidenceRef({ kind: 'git', gitBranch: 'b' })).toThrow(/gitCommit/);
  });

  it('assertCrossBoundaryPortable returns the parsed ref', () => {
    expect(assertCrossBoundaryPortable({ kind: 'artifact', artifactId: 'a1' })).toEqual({
      kind: 'artifact',
      artifactId: 'a1',
    });
  });
});
