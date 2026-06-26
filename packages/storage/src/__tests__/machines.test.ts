import { describe, expect, it } from 'vitest';
import {
  MACHINE_SECRET_BYTES,
  PAIRING_TOKEN_BYTES,
  generateMachineSecret,
  generatePairingToken,
  hashMachineSecret,
  hashPairingToken,
  isPairingTokenExpired,
  isPairingTokenUsable,
  isPairingTokenUsed,
} from '../machines.js';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function base64urlByteLength(value: string): number {
  return Buffer.from(value, 'base64url').length;
}

describe('hashMachineSecret', () => {
  it('is deterministic for the same input', () => {
    expect(hashMachineSecret('secret-a')).toBe(hashMachineSecret('secret-a'));
  });

  it('produces distinct hashes for distinct inputs', () => {
    expect(hashMachineSecret('secret-a')).not.toBe(hashMachineSecret('secret-b'));
  });

  it('emits lowercase sha256 hex', () => {
    expect(hashMachineSecret('secret-a')).toMatch(SHA256_HEX);
  });
});

describe('hashPairingToken', () => {
  it('is deterministic for the same input', () => {
    expect(hashPairingToken('tok-a')).toBe(hashPairingToken('tok-a'));
  });

  it('produces distinct hashes for distinct inputs', () => {
    expect(hashPairingToken('tok-a')).not.toBe(hashPairingToken('tok-b'));
  });

  it('emits lowercase sha256 hex', () => {
    expect(hashPairingToken('tok-a')).toMatch(SHA256_HEX);
  });
});

describe('generateMachineSecret', () => {
  it('yields 256 bits of entropy encoded as base64url', () => {
    const secret = generateMachineSecret();
    expect(secret).toMatch(BASE64URL);
    expect(base64urlByteLength(secret)).toBe(MACHINE_SECRET_BYTES);
  });

  it('is unique across calls', () => {
    const samples = new Set(Array.from({ length: 100 }, () => generateMachineSecret()));
    expect(samples.size).toBe(100);
  });
});

describe('generatePairingToken', () => {
  it('yields 256 bits of entropy encoded as base64url', () => {
    const token = generatePairingToken();
    expect(token).toMatch(BASE64URL);
    expect(base64urlByteLength(token)).toBe(PAIRING_TOKEN_BYTES);
  });

  it('is unique across calls', () => {
    const samples = new Set(Array.from({ length: 100 }, () => generatePairingToken()));
    expect(samples.size).toBe(100);
  });
});

describe('pairing token TTL predicates', () => {
  const now = new Date('2026-06-10T12:00:00.000Z');
  const future = new Date(now.getTime() + 60_000);
  const past = new Date(now.getTime() - 60_000);

  it('treats a future expiry as not expired', () => {
    expect(isPairingTokenExpired({ expiresAt: future, usedAt: null }, now)).toBe(false);
  });

  it('treats a past expiry as expired', () => {
    expect(isPairingTokenExpired({ expiresAt: past, usedAt: null }, now)).toBe(true);
  });

  it('treats an exact expiry boundary as expired', () => {
    expect(isPairingTokenExpired({ expiresAt: now, usedAt: null }, now)).toBe(true);
  });

  it('detects a redeemed token', () => {
    expect(isPairingTokenUsed({ expiresAt: future, usedAt: past })).toBe(true);
    expect(isPairingTokenUsed({ expiresAt: future, usedAt: null })).toBe(false);
  });

  it('is usable only when unused and unexpired', () => {
    expect(isPairingTokenUsable({ expiresAt: future, usedAt: null }, now)).toBe(true);
  });

  it('is unusable once redeemed even before expiry', () => {
    expect(isPairingTokenUsable({ expiresAt: future, usedAt: past }, now)).toBe(false);
  });

  it('is unusable once expired even if never redeemed', () => {
    expect(isPairingTokenUsable({ expiresAt: past, usedAt: null }, now)).toBe(false);
  });
});
