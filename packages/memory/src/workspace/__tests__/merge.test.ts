import { describe, expect, it } from 'vitest';
import { threeWayMerge } from '../merge.js';

const BASE = ['# Title', '', '## Section A', '- a1', '', '## Section B', '- b1', ''].join('\n');

describe('threeWayMerge', () => {
  it('returns ours when all three sides are identical', async () => {
    const result = await threeWayMerge(BASE, BASE, BASE);
    expect(result.clean).toBe(true);
    expect(result.merged).toBe(BASE);
  });

  it('fast-forwards to theirs when ours is unchanged from base', async () => {
    const theirs = BASE.replace('- a1', '- a1\n- a2');
    const result = await threeWayMerge(BASE, BASE, theirs);
    expect(result.clean).toBe(true);
    expect(result.merged).toBe(theirs);
  });

  it('keeps ours when theirs is unchanged from base', async () => {
    const ours = BASE.replace('- b1', '- b1\n- b2');
    const result = await threeWayMerge(BASE, ours, BASE);
    expect(result.clean).toBe(true);
    expect(result.merged).toBe(ours);
  });

  it('merges edits to different sections cleanly', async () => {
    const ours = BASE.replace('- a1', '- a1\n- a2 (from ours)');
    const theirs = BASE.replace('- b1', '- b1\n- b2 (from theirs)');
    const result = await threeWayMerge(BASE, ours, theirs);
    expect(result.clean).toBe(true);
    expect(result.merged).toContain('- a2 (from ours)');
    expect(result.merged).toContain('- b2 (from theirs)');
  });

  it('conflicts when both sides edit the same line differently', async () => {
    const ours = BASE.replace('- a1', '- a1 edited by ours');
    const theirs = BASE.replace('- a1', '- a1 edited by theirs');
    const result = await threeWayMerge(BASE, ours, theirs);
    expect(result.clean).toBe(false);
    expect(result.merged).toBeNull();
  });

  it('conflicts on create-create with different content (empty base)', async () => {
    const result = await threeWayMerge('', 'created by ours\n', 'created by theirs\n');
    expect(result.clean).toBe(false);
    expect(result.merged).toBeNull();
  });

  it('treats identical concurrent edits as clean', async () => {
    const edited = BASE.replace('- a1', '- a1 same edit');
    const result = await threeWayMerge(BASE, edited, edited);
    expect(result.clean).toBe(true);
    expect(result.merged).toBe(edited);
  });
});
