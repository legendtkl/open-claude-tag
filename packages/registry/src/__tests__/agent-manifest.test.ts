import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { readAgentManifests } from '../agent-manifest.js';

let tempRoot: string | undefined;

describe('readAgentManifests', () => {
  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  it('loads registry/agents/*.yaml manifests in deterministic order', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'open-claude-tag-registry-'));
    const agentsDir = join(tempRoot, 'registry', 'agents');
    await mkdir(agentsDir, { recursive: true });
    await writeFile(
      join(agentsDir, 'reviewer.yaml'),
      [
        'profile:',
        '  name: reviewer',
        '  displayName: Reviewer',
        '  skillRefs:',
        '    - code-review',
        'agent:',
        '  handle: reviewer',
        '  displayName: Reviewer',
        '  visibility: private',
      ].join('\n'),
    );
    await writeFile(
      join(agentsDir, 'coder.yml'),
      [
        'profile:',
        '  name: coder',
        '  displayName: Coder',
        'agent:',
        '  handle: coder',
        '  displayName: Coder',
      ].join('\n'),
    );
    await writeFile(join(agentsDir, 'ignored.txt'), 'not a manifest');

    const manifests = await readAgentManifests(tempRoot);

    expect(manifests.map((entry) => entry.manifest.agent.handle)).toEqual(['coder', 'reviewer']);
    expect(manifests[1].manifest.profile.skillRefs).toEqual(['code-review']);
    expect(manifests[1].relativePath).toBe('registry/agents/reviewer.yaml');
  });

  it('returns an empty list when registry/agents is missing', async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'open-claude-tag-registry-'));

    await expect(readAgentManifests(tempRoot)).resolves.toEqual([]);
  });
});
