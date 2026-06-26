import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('createLogger', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Reset module cache so env vars are re-read
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns a named logger', async () => {
    const { createLogger } = await import('../index.js');
    const logger = createLogger('test-service');
    // Pino loggers expose bindings with the name
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('respects LOG_LEVEL env var', async () => {
    process.env.LOG_LEVEL = 'debug';
    process.env.LOG_FILE_ENABLED = '';
    const { createLogger } = await import('../index.js');
    const logger = createLogger('test-level');
    expect(logger.level).toBe('debug');
  });

  it('defaults to info level', async () => {
    delete process.env.LOG_LEVEL;
    process.env.LOG_FILE_ENABLED = '';
    const { createLogger } = await import('../index.js');
    const logger = createLogger('test-default');
    expect(logger.level).toBe('info');
  });

  it('accepts level override via opts', async () => {
    process.env.LOG_FILE_ENABLED = '';
    const { createLogger } = await import('../index.js');
    const logger = createLogger('test-opts', { level: 'warn' });
    expect(logger.level).toBe('warn');
  });

  it('creates logger without file transport when LOG_FILE_ENABLED is not set', async () => {
    process.env.LOG_FILE_ENABLED = '';
    const { createLogger } = await import('../index.js');
    // Should not throw
    const logger = createLogger('test-no-file');
    expect(logger).toBeDefined();
  });

  it('creates logger with file transport when LOG_FILE_ENABLED=true', async () => {
    process.env.LOG_FILE_ENABLED = 'true';
    const { createLogger } = await import('../index.js');
    // Should not throw — pino-roll transport is created asynchronously
    const logger = createLogger('test-file');
    expect(logger).toBeDefined();
  });
});
