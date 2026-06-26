import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  DEV_AUTH_COOKIE_NAME,
  extractDevAuthSub,
  validateDevAuthSub,
} from '../admin-identity.js';

function requestWithCookie(cookie: string | undefined): FastifyRequest {
  return { headers: cookie === undefined ? {} : { cookie } } as FastifyRequest;
}

describe('validateDevAuthSub', () => {
  it('trims and accepts a safe-charset subject', () => {
    expect(validateDevAuthSub('  alice  ')).toBe('alice');
    expect(validateDevAuthSub('a.b_c-d@e')).toBe('a.b_c-d@e');
  });

  it('rejects empty, oversized, or unsafe subjects', () => {
    expect(validateDevAuthSub('')).toBeNull();
    expect(validateDevAuthSub('   ')).toBeNull();
    expect(validateDevAuthSub(undefined)).toBeNull();
    expect(validateDevAuthSub(null)).toBeNull();
    expect(validateDevAuthSub('bad sub!')).toBeNull();
    expect(validateDevAuthSub('a'.repeat(129))).toBeNull();
  });
});

describe('extractDevAuthSub', () => {
  it('reads and validates the dev-auth cookie value', () => {
    expect(extractDevAuthSub(requestWithCookie(`${DEV_AUTH_COOKIE_NAME}=alice`))).toBe('alice');
    expect(
      extractDevAuthSub(requestWithCookie(`other=x; ${DEV_AUTH_COOKIE_NAME}=bob; more=y`)),
    ).toBe('bob');
  });

  it('url-decodes the cookie value', () => {
    expect(extractDevAuthSub(requestWithCookie(`${DEV_AUTH_COOKIE_NAME}=al%40ice`))).toBe('al@ice');
  });

  it('returns null when the cookie is absent or invalid', () => {
    expect(extractDevAuthSub(requestWithCookie(undefined))).toBeNull();
    expect(extractDevAuthSub(requestWithCookie('foo=bar'))).toBeNull();
    expect(extractDevAuthSub(requestWithCookie(`${DEV_AUTH_COOKIE_NAME}=bad%20sub!`))).toBeNull();
  });
});
