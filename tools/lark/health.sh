#!/usr/bin/env bash
# Run lark-cli health check for Feishu connectivity and auth.
# Usage: ./tools/lark/health.sh
set -euo pipefail

if ! command -v lark-cli &>/dev/null; then
  echo "Error: lark-cli not found. Install with: npm install -g @larksuite/cli" >&2
  exit 1
fi

lark-cli doctor
