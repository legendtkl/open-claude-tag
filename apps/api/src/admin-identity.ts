import type { FastifyRequest } from 'fastify';

/**
 * Cookie name carrying a dev-auth identity (design D-A6, local non-SSO login).
 * The value is the raw (un-namespaced) dev subject; the guard resolves it to the
 * `dev:<sub>` platform user. Only honored when `OPEN_TAG_DEV_AUTH=enabled`.
 */
export const DEV_AUTH_COOKIE_NAME = 'cc_dev_user';

/** Max dev subject length / allowed charset (alnum, dash, underscore, dot, @). */
const DEV_AUTH_SUB_MAX_LENGTH = 128;
const DEV_AUTH_SUB_PATTERN = /^[A-Za-z0-9._@-]+$/;

/**
 * Validate a dev-auth subject (the `sub` field of `POST /admin/auth/dev-login`
 * and the value of the `cc_dev_user` cookie). Returns the trimmed subject when
 * it is a non-empty, reasonable-length, safe-charset string; otherwise null.
 * This keeps a hostile cookie/body from injecting an oversized or weird subject
 * into the namespaced `sso_sub`.
 */
export function validateDevAuthSub(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > DEV_AUTH_SUB_MAX_LENGTH) return null;
  if (!DEV_AUTH_SUB_PATTERN.test(trimmed)) return null;
  return trimmed;
}

/** Read the validated dev-auth subject from the `cc_dev_user` cookie, or null. */
export function extractDevAuthSub(request: FastifyRequest): string | null {
  const raw = readCookie(request.headers.cookie, DEV_AUTH_COOKIE_NAME);
  return validateDevAuthSub(raw);
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return null;
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}
