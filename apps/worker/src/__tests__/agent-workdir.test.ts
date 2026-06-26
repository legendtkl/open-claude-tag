import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { resolveTaskWorkDir, readDefaultWorkDirEnv } from '../agent-workdir.js';

describe('resolveTaskWorkDir', () => {
  it('prefers the session binding over chat and env', () => {
    expect(
      resolveTaskWorkDir({ sessionWorkDir: '/a', chatWorkDir: '/b', envWorkDir: '/c' }),
    ).toBe('/a');
  });

  it('falls back to the chat binding when session is unset', () => {
    expect(
      resolveTaskWorkDir({ sessionWorkDir: null, chatWorkDir: '/b', envWorkDir: '/c' }),
    ).toBe('/b');
  });

  it('falls back to the env default when session and chat are unset', () => {
    expect(
      resolveTaskWorkDir({ sessionWorkDir: null, chatWorkDir: null, envWorkDir: '/c' }),
    ).toBe('/c');
  });

  it('returns null when nothing is set', () => {
    expect(
      resolveTaskWorkDir({ sessionWorkDir: null, chatWorkDir: undefined, envWorkDir: null }),
    ).toBeNull();
  });

  it('treats empty strings as unset', () => {
    expect(
      resolveTaskWorkDir({ sessionWorkDir: '', chatWorkDir: '   ', envWorkDir: '/c' }),
    ).toBe('/c');
  });

  it('treats non-absolute session/chat values as unset', () => {
    expect(
      resolveTaskWorkDir({ sessionWorkDir: 'rel/session', chatWorkDir: 'rel/chat', envWorkDir: '/c' }),
    ).toBe('/c');
  });

  it('returns null when every tier is non-absolute', () => {
    expect(
      resolveTaskWorkDir({ sessionWorkDir: 'a', chatWorkDir: 'b', envWorkDir: 'c' }),
    ).toBeNull();
  });
});

describe('readDefaultWorkDirEnv', () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.OPEN_TAG_DEFAULT_WORKDIR;
    delete process.env.OPEN_TAG_DEFAULT_WORKDIR;
  });

  afterEach(() => {
    if (saved === undefined) delete process.env.OPEN_TAG_DEFAULT_WORKDIR;
    else process.env.OPEN_TAG_DEFAULT_WORKDIR = saved;
  });

  it('returns an absolute path', () => {
    process.env.OPEN_TAG_DEFAULT_WORKDIR = '/repos/api';
    expect(readDefaultWorkDirEnv()).toBe('/repos/api');
  });

  it('ignores a relative path', () => {
    process.env.OPEN_TAG_DEFAULT_WORKDIR = 'relative/x';
    expect(readDefaultWorkDirEnv()).toBeNull();
  });

  it('returns null when unset', () => {
    expect(readDefaultWorkDirEnv()).toBeNull();
  });
});
