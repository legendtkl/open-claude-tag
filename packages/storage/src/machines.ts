import { createHash, randomBytes } from 'node:crypto';
import type { machinePairingTokens } from './schema.js';

export type { MachineCapabilities } from './schema.js';

/** Default machine secret entropy in bytes (256 bits). */
export const MACHINE_SECRET_BYTES = 32;

/** Default pairing token entropy in bytes (256 bits). */
export const PAIRING_TOKEN_BYTES = 32;

/** Default pairing token time-to-live in milliseconds (10 minutes, design D5). */
export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;

type PairingTokenRow = typeof machinePairingTokens.$inferSelect;

/** TTL-relevant subset of a pairing token row, so callers can pass partial rows. */
export type PairingTokenLifetime = Pick<PairingTokenRow, 'expiresAt' | 'usedAt'>;

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Hash a machine secret for at-rest storage. SHA-256 hex; deterministic so the
 * gateway can compare a presented secret against the stored hash.
 */
export function hashMachineSecret(secret: string): string {
  return sha256Hex(secret);
}

/**
 * Hash a pairing token for at-rest storage. SHA-256 hex; the plaintext token is
 * only ever surfaced in the Feishu pairing card.
 */
export function hashPairingToken(token: string): string {
  return sha256Hex(token);
}

/** Generate a 256-bit machine secret as a URL-safe base64 string. */
export function generateMachineSecret(): string {
  return randomBytes(MACHINE_SECRET_BYTES).toString('base64url');
}

/** Generate a 256-bit one-time pairing token as a URL-safe base64 string. */
export function generatePairingToken(): string {
  return randomBytes(PAIRING_TOKEN_BYTES).toString('base64url');
}

/** Whether the pairing token is past its expiry at the given instant. */
export function isPairingTokenExpired(row: PairingTokenLifetime, now: Date): boolean {
  return row.expiresAt.getTime() <= now.getTime();
}

/** Whether the pairing token has already been redeemed. */
export function isPairingTokenUsed(row: PairingTokenLifetime): boolean {
  return row.usedAt != null;
}

/** Whether the pairing token can still be redeemed: not used and not expired. */
export function isPairingTokenUsable(row: PairingTokenLifetime, now: Date): boolean {
  return !isPairingTokenUsed(row) && !isPairingTokenExpired(row, now);
}
