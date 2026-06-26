/**
 * High-confidence secret detection for the workspace memory commit gate.
 *
 * Deliberately NOT the generic `sensitive-filter.ts` pattern set: its broad
 * base64 rule rejects any 40+ char alphanumeric run, which a coding agent's
 * notes hit constantly (git SHAs, URLs, hashes). The commit gate instead
 * matches only patterns that are near-certainly credentials; files that match
 * are rejected wholesale (never redact-and-store).
 */
const HIGH_CONFIDENCE_SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{20,}/, // OpenAI/Anthropic-style API keys
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?[^\s'"]{6,}/i,
  /\btoken\s*[:=]\s*['"]?[A-Za-z0-9._/+-]{16,}/i,
  /\bghp_[A-Za-z0-9]{36}\b/, // GitHub personal access token
  /\bgho_[A-Za-z0-9]{36}\b/, // GitHub OAuth token
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[bpors]-[A-Za-z0-9-]{10,}/, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\b/, // signed JWT
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
];

export function containsHighConfidenceSecret(text: string): boolean {
  return HIGH_CONFIDENCE_SECRET_PATTERNS.some((pattern) => pattern.test(text));
}
