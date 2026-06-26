/**
 * Subprocess fixture for the reconnect event-loop-drain regression.
 *
 * Reproduces the live-smoke failure mode: when the socket is closed and every
 * other timer has been cleared, the scheduled reconnect timer may be the ONLY
 * handle left on the event loop. If that timer is unref'd, Node drains the
 * loop and the process exits silently instead of reconnecting.
 *
 * This script wires a ConnectionManager whose wsFactory always throws (a
 * permanently unreachable server) with a tiny backoff. With a ref'd reconnect
 * timer the retry loop keeps the process alive; after three attempts we print
 * the marker and exit 0. With the regression, the process exits after the
 * first failed attempt WITHOUT printing the marker.
 *
 * Run via tsx from the parent vitest test. Intentionally creates no other
 * ref'd handles (no setInterval/setTimeout of its own).
 */
import { ConnectionManager } from '../../connection.js';
import { Backoff } from '../../backoff.js';
import { stubRuntimeManager } from '../stub-adapter.js';

const ATTEMPTS_REQUIRED = 3;
let attempts = 0;

const manager = new ConnectionManager({
  config: {
    serverUrl: 'http://127.0.0.1:1',
    machineId: 'fixture-machine',
    machineSecret: 'fixture-secret',
    name: 'fixture',
  },
  runtimeManager: stubRuntimeManager(undefined),
  backoff: new Backoff({ baseMs: 20, maxMs: 40, jitter: 0 }),
  wsFactory: () => {
    attempts += 1;
    if (attempts >= ATTEMPTS_REQUIRED) {
      // Loop survived long enough — report and leave before dialing again.
      process.stdout.write(`ALIVE attempts=${attempts}\n`);
      process.exit(0);
    }
    throw new Error('dial refused (fixture)');
  },
});

void manager.run();
