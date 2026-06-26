#!/usr/bin/env bash
# Send a test task card to a Feishu chat for visual verification.
# Usage: ./tools/lark/send-test-card.sh <chat-id> [ack|running|done|failed]
set -euo pipefail

if ! command -v lark-cli &>/dev/null; then
  echo "Error: lark-cli not found. Install with: npm install -g @larksuite/cli" >&2
  exit 1
fi

CHAT_ID="${1:?Usage: send-test-card.sh <chat-id> [ack|running|done|failed]}"
CARD_TYPE="${2:-done}"

case "$CARD_TYPE" in
  ack)
    TITLE="Request received"
    TEMPLATE="blue"
    DESC="Test task description from send-test-card.sh"
    DETAIL=""
    ;;
  running)
    TITLE="Running (50%)"
    TEMPLATE="orange"
    DESC="Test task description from send-test-card.sh"
    DETAIL=""
    ;;
  done)
    TITLE="Task complete"
    TEMPLATE="green"
    DESC="Test task description from send-test-card.sh"
    DETAIL='{"tag":"markdown","content":"**Result**\nThis is a test result from lark-cli dev tools.","element_id":"detail_markdown"}'
    ;;
  failed)
    TITLE="Task failed"
    TEMPLATE="red"
    DESC="Test task description from send-test-card.sh"
    DETAIL='{"tag":"markdown","content":"**Error**\nThis is a test error from lark-cli dev tools.","element_id":"detail_markdown"}'
    ;;
  *)
    echo "Error: Unknown card type '$CARD_TYPE'. Use: ack, running, done, failed" >&2
    exit 1
    ;;
esac

ELEMENTS='[{"tag":"markdown","content":"'"$DESC"'","element_id":"task_markdown"}'
if [ -n "$DETAIL" ]; then
  ELEMENTS="$ELEMENTS"',{"tag":"hr","element_id":"detail_divider"},'"$DETAIL"
fi
ELEMENTS="$ELEMENTS]"

CARD_JSON=$(cat <<EOF
{
  "schema": "2.0",
  "config": {"update_multi": true, "width_mode": "fill", "enable_forward": true},
  "header": {
    "title": {"tag": "plain_text", "content": "$TITLE"},
    "template": "$TEMPLATE",
    "text_tag_list": [{"tag": "text_tag", "text": {"tag": "plain_text", "content": "task"}, "color": "blue"}]
  },
  "body": {
    "direction": "vertical",
    "padding": "8px 12px",
    "vertical_spacing": "4px",
    "elements": $ELEMENTS
  }
}
EOF
)

echo "Sending $CARD_TYPE card to $CHAT_ID..."
lark-cli im +messages-send --chat-id "$CHAT_ID" --msg-type interactive --content "$CARD_JSON"
