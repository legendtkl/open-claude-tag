import { describe, expect, it } from 'vitest';
import { releaseNotes } from './release-notes';

describe('release-notes data', () => {
  it('ships 1.0.5 as the latest release note', () => {
    const versions = releaseNotes.map((note) => note.version);
    expect(versions[0]).toBe('1.0.5');
    expect(versions).toContain('1.0.4');
    expect(versions).toContain('1.0.3');
    expect(versions).toContain('1.0.2');
    // Newest-first ordering by semver.
    const sorted = [...versions].sort((a, b) => compareSemver(b, a));
    expect(versions).toEqual(sorted);
  });

  it('describes the major product changes shipped after 1.0.4', () => {
    const latest = releaseNotes[0];
    expect(latest.version).toBe('1.0.5');
    expect(latest.date).toBe('2026-06-24');
    const englishCopy = [...latest.highlights, ...latest.fixes]
      .map((item) => item.en)
      .join('\n');
    expect(englishCopy).toContain('Feishu document comments');
    expect(englishCopy).toContain('macOS desktop downloads');
    expect(englishCopy).toContain('light blue console');
  });

  it('keeps bilingual copy for every highlight and fix', () => {
    for (const note of releaseNotes) {
      for (const item of [...note.highlights, ...note.fixes]) {
        expect(item.zh.trim().length).toBeGreaterThan(0);
        expect(item.en.trim().length).toBeGreaterThan(0);
      }
    }
  });
});

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  }
  return 0;
}
