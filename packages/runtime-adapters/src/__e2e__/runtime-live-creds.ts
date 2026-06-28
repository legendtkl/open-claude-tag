import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Credential-presence detection for the opt-in live runtime e2e command. Pure
 * and injectable (env + home dir) so it is unit-testable without touching the
 * host. NEVER reads, logs, or returns credential VALUES — only whether a runtime
 * has *some* usable credential, which gates the self-skip in the live e2e.
 */
export interface CredProbe {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function hasValue(value: string | undefined): boolean {
  return (value ?? '').trim().length > 0;
}

/**
 * Codex has credentials when an explicit API key env var is set, or the host
 * login token store `~/.codex/auth.json` exists. `auth.json` is Codex's actual
 * credential file; `config.toml` is non-credential config, so it is deliberately
 * NOT treated as a credential signal (a host with only `config.toml` would
 * otherwise falsely report "present" and the live call would fail with an auth
 * error instead of skipping).
 */
export function codexCredsPresent(probe: CredProbe = {}): boolean {
  const env = probe.env ?? process.env;
  const homeDir = probe.homeDir ?? homedir();
  if (hasValue(env.CODEX_API_KEY) || hasValue(env.OPENAI_API_KEY)) return true;
  return isFile(join(homeDir, '.codex', 'auth.json'));
}

/**
 * Claude Code has credentials when an explicit auth env var is set, or the CLI
 * login token store `~/.claude/.credentials.json` exists. Note: presence of
 * credentials does NOT guarantee the run will succeed — Claude Code also needs
 * an HTTPS proxy reachable to api.anthropic.com, which the operator supplies via
 * ambient env. Creds-present-but-no-proxy is a real operator misconfiguration
 * that surfaces as a test failure, not a skip (documented in AGENTS.md).
 */
export function claudeCredsPresent(probe: CredProbe = {}): boolean {
  const env = probe.env ?? process.env;
  const homeDir = probe.homeDir ?? homedir();
  if (hasValue(env.ANTHROPIC_API_KEY) || hasValue(env.ANTHROPIC_AUTH_TOKEN)) return true;
  return isFile(join(homeDir, '.claude', '.credentials.json'));
}
