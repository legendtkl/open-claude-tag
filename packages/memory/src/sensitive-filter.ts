// Patterns that indicate sensitive information
const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g, // API keys
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g, // Base64 encoded secrets (long)
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/g,
  /password\s*[:=]\s*\S+/gi,
  /token\s*[:=]\s*\S+/gi,
  /secret\s*[:=]\s*\S+/gi,
  /api[_-]?key\s*[:=]\s*\S+/gi,
  /ghp_[a-zA-Z0-9]{36}/g, // GitHub personal access token
  /gho_[a-zA-Z0-9]{36}/g, // GitHub OAuth token
  /xox[bpors]-[a-zA-Z0-9-]+/g, // Slack token
];

export function containsSensitiveInfo(text: string): boolean {
  return SENSITIVE_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0; // Reset regex state
    return pattern.test(text);
  });
}

export function filterSensitiveContent(text: string): string {
  let filtered = text;
  for (const pattern of SENSITIVE_PATTERNS) {
    pattern.lastIndex = 0;
    filtered = filtered.replace(pattern, '[REDACTED]');
  }
  return filtered;
}
