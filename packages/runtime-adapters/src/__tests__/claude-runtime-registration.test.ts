import { describe, expect, it, vi } from 'vitest';
import type { RuntimeAdapter } from '../types.js';

vi.mock('../claude-code-adapter.js', () => ({
  ClaudeCodeAdapter: class {
    constructor(public readonly config: { authToken?: string; imageDownloader?: unknown }) {}

    name(): string {
      return 'claude_code';
    }
  },
}));

import { registerClaudeRuntimeAdapter } from '../claude-runtime-registration.js';

function createRuntimeManagerStub() {
  const adapters: RuntimeAdapter[] = [];

  return {
    register(adapter: RuntimeAdapter) {
      adapters.push(adapter);
    },
    get(name: string) {
      return adapters.find((adapter) => adapter.name() === name);
    },
  };
}

function getClaudeConfig(manager: ReturnType<typeof createRuntimeManagerStub>) {
  const adapter = manager.get('claude_code') as
    | (RuntimeAdapter & {
        config?: { authToken?: string; imageDownloader?: unknown };
      })
    | undefined;
  return adapter?.config;
}

describe('registerClaudeRuntimeAdapter', () => {
  it('uses ANTHROPIC_API_KEY when it is the only configured Claude auth env', () => {
    const manager = createRuntimeManagerStub();

    const registered = registerClaudeRuntimeAdapter(manager, {
      env: {
        ANTHROPIC_BASE_URL: 'https://proxy.example',
        ANTHROPIC_API_KEY: 'api-key-only',
      },
    });

    expect(registered).toBe(true);
    expect(getClaudeConfig(manager)?.authToken).toBe('api-key-only');
  });

  it('prefers ANTHROPIC_API_KEY and keeps image downloader wiring', () => {
    const manager = createRuntimeManagerStub();
    const imageDownloader = {
      downloadImage: vi.fn(),
    };

    const registered = registerClaudeRuntimeAdapter(manager, {
      env: {
        ANTHROPIC_BASE_URL: 'https://proxy.example',
        ANTHROPIC_API_KEY: 'preferred-api-key',
        ANTHROPIC_AUTH_TOKEN: 'legacy-token',
      },
      imageDownloader,
    });

    const config = getClaudeConfig(manager);
    expect(registered).toBe(true);
    expect(config?.authToken).toBe('preferred-api-key');
    expect(config?.imageDownloader).toBe(imageDownloader);
  });

  it('registers even when ANTHROPIC_BASE_URL is missing (per-agent provides creds)', () => {
    const manager = createRuntimeManagerStub();

    const registered = registerClaudeRuntimeAdapter(manager, {
      env: {
        ANTHROPIC_API_KEY: 'api-key-only',
      },
    });

    expect(registered).toBe(true);
    expect(manager.get('claude_code')).toBeDefined();
  });

  it('registers with no global Claude env at all (per-agent runtimeEnv supplies creds)', () => {
    const manager = createRuntimeManagerStub();

    const registered = registerClaudeRuntimeAdapter(manager, { env: {} });

    expect(registered).toBe(true);
    expect(manager.get('claude_code')).toBeDefined();
  });
});
