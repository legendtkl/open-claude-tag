import { describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';

describe('parseArgs', () => {
  it('defaults to help with no args', () => {
    expect(parseArgs([]).command).toBe('help');
  });

  it('parses each command', () => {
    expect(parseArgs(['up']).command).toBe('up');
    expect(parseArgs(['down']).command).toBe('down');
    expect(parseArgs(['status']).command).toBe('status');
    expect(parseArgs(['db-host']).command).toBe('db-host');
  });

  it('parses up flags', () => {
    const parsed = parseArgs(['up', '--build', '--no-open']);
    expect(parsed.command).toBe('up');
    expect(parsed.build).toBe(true);
    expect(parsed.noOpen).toBe(true);
    expect(parsed.noBuild).toBe(false);
  });

  it('honors --no-build', () => {
    expect(parseArgs(['up', '--no-build']).noBuild).toBe(true);
  });

  it('treats --help as the help command', () => {
    expect(parseArgs(['up', '--help']).command).toBe('help');
  });

  it('collects unknown tokens', () => {
    const parsed = parseArgs(['up', '--frobnicate']);
    expect(parsed.unknown).toEqual(['--frobnicate']);
  });

  it('only the first command token wins', () => {
    const parsed = parseArgs(['up', 'down']);
    expect(parsed.command).toBe('up');
    expect(parsed.unknown).toEqual(['down']);
  });
});
