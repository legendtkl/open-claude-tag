#!/usr/bin/env node
import { main } from './cli.js';
import { logger } from './logger.js';

main(process.argv).catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : String(err) }, 'Daemon CLI failed');
  process.exitCode = 1;
});
