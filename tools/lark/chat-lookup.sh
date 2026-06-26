#!/usr/bin/env bash
# Look up Feishu chat IDs by group name keyword.
# Usage: ./tools/lark/chat-lookup.sh "group name keyword"
set -euo pipefail

if ! command -v lark-cli &>/dev/null; then
  echo "Error: lark-cli not found. Install with: npm install -g @larksuite/cli" >&2
  exit 1
fi

QUERY="${1:?Usage: chat-lookup.sh \"group name keyword\"}"
lark-cli im +chat-search --query "$QUERY" --format table
