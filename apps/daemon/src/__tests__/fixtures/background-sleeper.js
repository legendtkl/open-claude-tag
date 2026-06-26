#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';

async function markReady() {
  const home = process.env.OPEN_TAG_HOME;
  const nonce = process.env.OPEN_TAG_DAEMON_BACKGROUND_NONCE;
  if (!home || !nonce) return;
  const pidPath = join(home, 'daemon.pid');
  for (let i = 0; i < 50; i++) {
    try {
      const metadata = JSON.parse(await readFile(pidPath, 'utf8'));
      if (metadata.pid === process.pid && metadata.nonce === nonce) {
        await writeFile(
          pidPath,
          `${JSON.stringify({ ...metadata, state: 'ready', readyAt: new Date().toISOString() }, null, 2)}\n`,
        );
        return;
      }
    } catch {
      // Parent may not have written the pid file yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

process.stdout.write('background fixture started\n');
void markReady();
process.on('SIGTERM', () => {
  process.stdout.write('background fixture stopped\n');
  process.exit(0);
});
setInterval(() => {}, 1_000);
