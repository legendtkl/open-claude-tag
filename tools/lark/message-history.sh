#!/usr/bin/env bash
# Fetch recent messages from a Feishu chat for debugging.
# Usage: ./tools/lark/message-history.sh <chat-id> [count]
set -euo pipefail

if ! command -v lark-cli &>/dev/null; then
  echo "Error: lark-cli not found. Install with: npm install -g @larksuite/cli" >&2
  exit 1
fi

CHAT_ID="${1:?Usage: message-history.sh <chat-id> [count]}"
PAGE_SIZE="${2:-10}"
lark-cli im +chat-messages-list --chat-id "$CHAT_ID" --page-size "$PAGE_SIZE" --format pretty
