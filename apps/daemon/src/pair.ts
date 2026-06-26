import { z } from 'zod';
import type { Capabilities } from '@open-tag/daemon-protocol';

/**
 * REST pairing client (design §6 — `POST /daemon/pair`).
 *
 * Exchanges a one-time Feishu-issued token for a long-lived `machineId` +
 * `machineSecret`. The secret is returned to the caller (which persists it 0600
 * via the config store) and is NEVER logged here.
 */

/** Successful pairing response body (design §6). */
export const PairResponseSchema = z.object({
  machineId: z.string().min(1),
  machineName: z.string().min(1),
  machineSecret: z.string().min(1),
  serverProtocol: z.object({ min: z.number().int(), max: z.number().int() }),
  heartbeatSec: z.number().positive(),
});

export type PairResponse = z.infer<typeof PairResponseSchema>;

export interface PairRequest {
  serverUrl: string;
  token: string;
  name?: string;
  capabilities: Capabilities;
}

/** A pairing error carrying the HTTP status for friendly CLI messaging. */
export class PairError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PairError';
  }
}

/** Joins the server base URL with the pairing path, tolerating a trailing slash. */
export function pairUrl(serverUrl: string): string {
  return `${serverUrl.replace(/\/+$/, '')}/daemon/pair`;
}

/**
 * Builds a friendly, actionable message for the known failure statuses
 * (design §6: 401 invalid/expired/used token, 409 name taken).
 */
export function describePairFailure(status: number, body: string): string {
  if (status === 401) {
    return 'Pairing token is invalid, expired, or already used. Generate a fresh token in the admin console (Machines page → Generate pairing token; valid 10 minutes).';
  }
  if (status === 409) {
    return 'This machine name is currently unavailable, or another pairing just updated it. Retry with the same token; if it still fails, re-run connect with a different --name.';
  }
  return `Pairing failed (HTTP ${status}): ${body.slice(0, 300)}`;
}

/**
 * Performs the pairing exchange. Throws {@link PairError} (with status) on any
 * non-2xx response or malformed body. The `fetchFn` is injectable for tests.
 */
export async function pair(
  req: PairRequest,
  fetchFn: typeof fetch = fetch,
): Promise<PairResponse> {
  const url = pairUrl(req.serverUrl);
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: req.token,
        name: req.name,
        capabilities: req.capabilities,
      }),
    });
  } catch (err) {
    throw new PairError(
      `Could not reach the server at ${req.serverUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new PairError(describePairFailure(res.status, body), res.status);
  }

  const json: unknown = await res.json().catch(() => null);
  const parsed = PairResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new PairError(`Server returned an unexpected pairing response: ${parsed.error.message}`);
  }
  return parsed.data;
}
