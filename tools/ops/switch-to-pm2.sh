#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."
REPO_ROOT="$(pwd -P)"

pid_for_port() {
  local port="$1"
  ss -ltnpH 2>/dev/null \
    | awk -v suffix=":$port" '$4 ~ suffix"$" { print $0 }' \
    | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' \
    | sort -u
}

stop_port_listener() {
  local port="$1"
  local pids
  pids="$(pid_for_port "$port" || true)"
  [ -n "$pids" ] || return 0

  while IFS= read -r pid; do
    [ -n "$pid" ] || continue
    local cwd
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    case "$cwd" in
      "$REPO_ROOT"|"$REPO_ROOT"/*)
        echo "Stopping old OpenClaudeTag listener pid=$pid port=$port cwd=$cwd"
        kill -TERM "$pid" 2>/dev/null || true
        ;;
      *)
        echo "Refusing to stop pid=$pid port=$port cwd=$cwd" >&2
        exit 1
        ;;
    esac
  done <<< "$pids"
}

wait_for_ports_to_close() {
  local ports=("$@")
  for _ in $(seq 1 40); do
    local listeners=""
    for port in "${ports[@]}"; do
      listeners+=$(pid_for_port "$port" || true)
    done
    [ -z "$listeners" ] && return 0
    sleep 0.25
  done

  for port in "${ports[@]}"; do
    if [ -n "$(pid_for_port "$port")" ]; then
      echo "Port $port still has a listener after graceful stop" >&2
      return 1
    fi
  done
}

main() {
  mkdir -p logs/pm2
  pnpm exec pm2 delete open-claude-tag-api open-claude-tag-worker open-claude-tag-console >/dev/null 2>&1 || true

  stop_port_listener 8080
  stop_port_listener 3001
  stop_port_listener 3000
  wait_for_ports_to_close 8080 3001 3000

  pnpm exec pm2 update >/dev/null 2>&1 || true
  pnpm exec pm2 start tools/ops/pm2.config.cjs
  pnpm exec pm2 save
  pnpm exec pm2 status
}

main "$@"
