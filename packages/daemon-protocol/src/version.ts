/**
 * Protocol version negotiation (design D4).
 *
 * The server is authoritative: it advertises the inclusive range of protocol
 * versions it supports, and rejects daemons whose `hello.protocolVersion`
 * falls outside that range with a `hello_error` of code `protocol_incompatible`.
 */

/** The protocol version this build of the package speaks. */
export const PROTOCOL_VERSION = 1 as const;

/** Inclusive range of protocol versions supported by this build. */
export interface ProtocolRange {
  min: number;
  max: number;
}

/** The range advertised by a server built from this package. */
export const SUPPORTED_PROTOCOL_RANGE: ProtocolRange = { min: 1, max: 1 };

/**
 * Returns true when `version` falls within the inclusive `range`.
 *
 * A malformed range (min > max) is treated as supporting nothing.
 */
export function isProtocolCompatible(version: number, range: ProtocolRange): boolean {
  if (range.min > range.max) {
    return false;
  }
  return version >= range.min && version <= range.max;
}
