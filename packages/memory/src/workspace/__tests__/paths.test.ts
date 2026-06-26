import { describe, expect, it } from 'vitest';
import { isMemoryPath, resolveInside } from '../paths.js';

describe('isMemoryPath', () => {
  it.each([
    'MEMORY.md',
    'notes/work-log.md',
    'notes/active/task-123.md',
    'notes/sub/deep/file.md',
    'notes/with-dash_and.dots.md',
  ])('accepts %s', (path) => {
    expect(isMemoryPath(path)).toBe(true);
  });

  it.each([
    'memory.md',
    'OTHER.md',
    'notes/a.txt',
    'notes/script.sh',
    'notes',
    'notes/',
    'notes/../MEMORY.md',
    'notes/../../etc/passwd.md',
    'notes/.hidden.md',
    'runs/task-1/notes/a.md',
    '.conflicts/x.md',
    '.base.json',
    '/etc/notes/a.md',
    'scripts/run.md',
  ])('rejects %s', (path) => {
    expect(isMemoryPath(path)).toBe(false);
  });
});

describe('resolveInside', () => {
  const root = '/tmp/agent-home';

  it('resolves allowlisted relative paths inside the root', () => {
    expect(resolveInside(root, 'notes/a.md')).toBe('/tmp/agent-home/notes/a.md');
    expect(resolveInside(root, 'MEMORY.md')).toBe('/tmp/agent-home/MEMORY.md');
  });

  it('rejects traversal and absolute paths', () => {
    expect(resolveInside(root, '../outside.md')).toBeNull();
    expect(resolveInside(root, 'notes/../../outside.md')).toBeNull();
    expect(resolveInside(root, '/etc/passwd')).toBeNull();
    expect(resolveInside(root, 'notes/\0evil.md')).toBeNull();
  });
});
