import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = new URL('../../../../', import.meta.url);
const rootPackageJsonPath = new URL('../../../../package.json', import.meta.url);

// Real, post-rebrand docs that must stay on the @open-tag/ scope.
const activeDocPaths = [
  new URL('../../../../AGENTS.md', import.meta.url),
  new URL('../../../../README.md', import.meta.url),
  new URL('../../../../.github/copilot-instructions.md', import.meta.url),
  new URL('../../../../packages/runtime-adapters/workflows/self-dev-common.md', import.meta.url),
];

function readJson(path: URL): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function collectWorkspacePackageJsonPaths(): string[] {
  const rootPath = repoRoot.pathname;
  const workspaceDirs = [join(rootPath, 'apps'), join(rootPath, 'packages')];

  return workspaceDirs.flatMap((dir) =>
    readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(dir, entry.name, 'package.json'))
      .filter((path) => existsSync(path)),
  );
}

describe('Workspace package identity', () => {
  it('uses open-claude-tag as the root package identity', () => {
    const rootPackageJson = readJson(rootPackageJsonPath);

    expect(rootPackageJson.name).toBe('open-claude-tag');
    // Pre-existing drift: the package description was reworded in the README
    // overhaul (commit 0a352ab) but this assertion was not updated. Pin it to a
    // stable phrase from the current description instead of the old brand string.
    expect(rootPackageJson.description).toContain('channels and runtimes');

    const scripts = rootPackageJson.scripts as Record<string, string>;
    const filterScripts = Object.values(scripts).filter((script) => script.includes('pnpm --filter'));

    expect(filterScripts.length).toBeGreaterThan(0);
    expect(filterScripts.every((script) => script.includes('@open-tag/'))).toBe(true);
  });

  it('uses the @open-tag scope across all workspace manifests', () => {
    for (const packageJsonPath of collectWorkspacePackageJsonPaths()) {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };

      expect(packageJson.name).toMatch(/^@open-tag\//);

      const allDeps = {
        ...(packageJson.dependencies ?? {}),
        ...(packageJson.devDependencies ?? {}),
        ...(packageJson.peerDependencies ?? {}),
      };
      const internalWorkspaceDeps = Object.entries(allDeps)
        .filter(([, version]) => version.startsWith('workspace:'))
        .map(([dep]) => dep);

      expect(internalWorkspaceDeps.every((dep) => dep.startsWith('@open-tag/'))).toBe(true);
    }
  });

  it('keeps active docs and workflows on the renamed package scope', () => {
    for (const docPath of activeDocPaths) {
      expect(existsSync(docPath)).toBe(true);

      const content = readFileSync(docPath, 'utf8');
      expect(content).toContain('@open-tag/');
    }
  });
});
