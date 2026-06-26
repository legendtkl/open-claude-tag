#!/usr/bin/env bash
# Create (or refresh) a OpenClaudeTag self-dev worktree.
#
# Usage:
#   tools/worktree/create.sh <name> [--no-install]
#
#   <name>          kebab-case worktree name, e.g. "fix-card-ack"
#   --no-install    skip `pnpm install` (useful when only refreshing .env)
#
# Behavior:
#   - Creates `.claude/worktrees/<name>` on branch `dev/<name>` from `main`.
#   - Reuses an existing branch with the same name when present.
#   - Symlinks the main repo `.env` into the worktree (gitignored, must be propagated).
#   - Runs `pnpm install --frozen-lockfile` inside the worktree (skip with --no-install).
#
# Idempotent: safe to re-run on an existing worktree; the .env symlink is refreshed.
# MUST be run from the main repo root (not from another worktree).

set -euo pipefail

NAME=""
SKIP_INSTALL=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --no-install)
      SKIP_INSTALL=1
      shift
      ;;
    -h|--help)
      sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    -*)
      echo "unknown flag: $1" >&2
      exit 2
      ;;
    *)
      if [[ -n "$NAME" ]]; then
        echo "unexpected positional argument: $1" >&2
        exit 2
      fi
      NAME="$1"
      shift
      ;;
  esac
done

if [[ -z "$NAME" ]]; then
  echo "usage: tools/worktree/create.sh <kebab-case-name> [--no-install]" >&2
  exit 2
fi

if ! [[ "$NAME" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
  echo "name must be kebab-case (lowercase letters, digits, hyphens)" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
COMMON_DIR="$(cd "$REPO_ROOT" && git rev-parse --git-common-dir)"
case "$COMMON_DIR" in
  /*) ABS_COMMON_DIR="$COMMON_DIR" ;;
  *)  ABS_COMMON_DIR="$REPO_ROOT/$COMMON_DIR" ;;
esac
MAIN_ROOT="$(cd "$ABS_COMMON_DIR/.." && pwd)"

if [[ "$REPO_ROOT" != "$MAIN_ROOT" ]]; then
  echo "error: must be run from the main repo root, not a worktree" >&2
  echo "       cwd repo:  $REPO_ROOT" >&2
  echo "       main repo: $MAIN_ROOT" >&2
  exit 2
fi

WORKTREE_PATH="$REPO_ROOT/.claude/worktrees/$NAME"
BRANCH="dev/$NAME"

if [[ -d "$WORKTREE_PATH" ]]; then
  echo "==> worktree already exists at $WORKTREE_PATH (reusing)"
elif git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "==> branch $BRANCH already exists; attaching worktree at $WORKTREE_PATH"
  git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" "$BRANCH"
else
  echo "==> creating worktree $WORKTREE_PATH on new branch $BRANCH (from main)"
  git -C "$REPO_ROOT" worktree add "$WORKTREE_PATH" -b "$BRANCH" main
fi

# Propagate .env into the worktree.
#
# If the main .env declares FEISHU_DEV_APP_ID and FEISHU_DEV_APP_SECRET, copy the
# .env into the worktree (instead of symlinking) and rewrite FEISHU_APP_ID and
# FEISHU_APP_SECRET to the dev-bot values. This lets isolated instances connect
# to a separate Feishu app for @bot validation without conflicting with the
# primary's WS subscription. OPEN_TAG_FEISHU_ACCESS=enabled is appended so the
# isolated stack actually opens the Feishu WSClient.
#
# Otherwise (or if dev creds are missing), fall back to a symlink — the worktree
# inherits prod creds but isolated mode keeps Feishu disabled, matching the old
# behavior.
extract_env_value() {
  # Strip optional surrounding quotes from a KEY=VALUE line; missing key -> empty.
  local key="$1" file="$2"
  awk -v k="$key" -F= '
    $0 ~ "^[[:space:]]*"k"=" {
      sub("^[[:space:]]*"k"=", "")
      gsub(/^["\047]|["\047]$/, "")
      print
      exit
    }
  ' "$file"
}

if [[ -f "$REPO_ROOT/.env" ]]; then
  PROD_APP_ID="$(extract_env_value FEISHU_APP_ID "$REPO_ROOT/.env")"
  DEV_APP_ID="$(extract_env_value FEISHU_DEV_APP_ID "$REPO_ROOT/.env")"
  DEV_APP_SECRET="$(extract_env_value FEISHU_DEV_APP_SECRET "$REPO_ROOT/.env")"

  if [[ -n "$DEV_APP_ID" && -n "$DEV_APP_SECRET" ]]; then
    if [[ "$DEV_APP_ID" == "$PROD_APP_ID" ]]; then
      echo "error: FEISHU_DEV_APP_ID equals FEISHU_APP_ID; refusing to create dev .env" >&2
      echo "       both bots subscribing to the same app would double-process events" >&2
      exit 2
    fi
    echo "==> writing worktree .env with dev-bot creds (Feishu access enabled)"
    rm -f "$WORKTREE_PATH/.env"
    python3 - "$REPO_ROOT/.env" "$WORKTREE_PATH/.env" "$DEV_APP_ID" "$DEV_APP_SECRET" <<'PY'
import re, sys
src, dst, dev_id, dev_secret = sys.argv[1:5]
with open(src, "r", encoding="utf-8") as f:
    text = f.read()
text = re.sub(r'^FEISHU_APP_ID=.*$',     f'FEISHU_APP_ID={dev_id}',         text, count=1, flags=re.M)
text = re.sub(r'^FEISHU_APP_SECRET=.*$', f'FEISHU_APP_SECRET={dev_secret}', text, count=1, flags=re.M)
if not text.endswith("\n"):
    text += "\n"
text += "\n# Injected by tools/worktree/create.sh — opt-in for isolated Feishu access\nOPEN_TAG_FEISHU_ACCESS=enabled\n"
with open(dst, "w", encoding="utf-8") as f:
    f.write(text)
PY
    chmod 600 "$WORKTREE_PATH/.env"
  else
    echo "==> dev bot creds not configured; linking .env (worktree will run with Feishu disabled)"
    ln -sfn "$REPO_ROOT/.env" "$WORKTREE_PATH/.env"
  fi
else
  echo "warning: $REPO_ROOT/.env does not exist; nothing to link" >&2
fi

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  echo "==> pnpm install --frozen-lockfile (in worktree)"
  ( cd "$WORKTREE_PATH" && pnpm install --frozen-lockfile )
else
  echo "==> skipping pnpm install (--no-install)"
fi

cat <<EOF

Worktree ready: $WORKTREE_PATH
Branch:         $BRANCH

Next steps:
  cd $WORKTREE_PATH
  pnpm db:setup:isolated   # when you need an isolated DB for verification
EOF
