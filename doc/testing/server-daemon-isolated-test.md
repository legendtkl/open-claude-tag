# Isolated server↔daemon remote-execution test (shared remote host + local daemon)

End-to-end test of the remote execution path — a central **server** dispatches a task to a
remote **daemon** that executes it with a runtime the server itself does not have. This is the
canonical way to validate a new runtime adapter (e.g. `coco`) over the daemon boundary, and to
exercise the D8 offline fail-fast invariant.

The server runs on the shared remote host **fully isolated from the production stack** (separate
dir, DB, ports, Feishu disabled); the daemon runs on your local machine where the runtime CLI
(`coco`) is installed. Verified once on 2026-06-14 (coco runtime).

## Topology

```
 local machine (daemon)                         remote host server.example.com (server, isolated)
 ┌──────────────────────┐   ssh -L 5300 tunnel  ┌───────────────────────────────────────┐
 │ open-claude-tag-daemon    │ ───────────────────►  │ API   :3300   Worker gateway :5300(lo) │
 │  RuntimeManager:      │   wss /daemon/ws      │ DB    openClaudeTag_coco_test (same pg)   │
 │  coco + codex (local) │ ◄───────────────────  │ Feishu DISABLED, dev-auth ENABLED      │
 └──────────────────────┘   task_event stream   │ Worker has NO coco → must go remote    │
                                                 └───────────────────────────────────────┘
 prod stack on the same remote host (3000/3001/8080/5432) is never touched.
```

Daemon dials **outbound** to the gateway (design D2). The gateway binds **loopback** on the
remote host (`DAEMON_GATEWAY_PUBLIC=false`) — we do **not** expose a second public port on the shared
box. The local daemon reaches it through an SSH `-L` tunnel.

## Isolation invariants (do not break)

- Separate deploy dir `~/cc-coco-isolated` (never `~/OpenClaudeTag`, which is prod).
- Separate DB `openClaudeTag_coco_test` in the same embedded Postgres (prod DB `open-claude-tag` untouched).
- Isolated ports **3300** (API) / **5300** (gateway); prod uses 3000/3001/8080/5432.
- `OPEN_TAG_INSTANCE_ROLE=isolated` + `OPEN_TAG_FEISHU_ACCESS=disabled` + a **dummy**
  `FEISHU_APP_ID` → the isolated API opens **no** Feishu WS (prod is the sole subscriber).
- Stop isolated procs by **listening port → /proc/<pid>/cwd contains `cc-coco-isolated`**, never a
  bare `pkill -f apps/api/dist/server.js` (that pattern also matches the prod process).

## 1. Server: deploy isolated stack on the remote host

```bash
# reach the remote host over SSH
SSH='ssh -o StrictHostKeyChecking=no youruser@server.example.com'

# 1a. create the isolated DB (additive; prod data untouched). Run from a pkg dir so
#     node resolves the `postgres` module from node_modules.
$SSH 'cd ~/OpenClaudeTag/packages/storage && cat > ._mk.mjs <<JS
import postgres from "postgres";
const s = postgres("postgresql://open-claude-tag:open-claude-tag@127.0.0.1:5432/postgres");
await s.unsafe("CREATE DATABASE openClaudeTag_coco_test").catch(()=>{});
await s.end();
JS
node ._mk.mjs; rm -f ._mk.mjs'

# 1b. ship the branch (remote host has NO git origin → use a bundle). Full bundle is small (~6 MB).
git bundle create /tmp/cc-coco.bundle HEAD
scp /tmp/cc-coco.bundle youruser@server.example.com:~/cc-coco.bundle
$SSH 'rm -rf ~/cc-coco-isolated && git clone -q ~/cc-coco.bundle ~/cc-coco-isolated'

# 1c. install + build (warm pnpm store → fast), exclude desktop
$SSH 'cd ~/cc-coco-isolated && npm_config_registry=https://registry.example.com NODE_OPTIONS=--max-old-space-size=2048 pnpm install --no-frozen-lockfile && pnpm -r --filter "!@open-tag/desktop" build'

# 1d. isolated .env: clone prod .env minus the keys we override, then append overrides
$SSH 'cd ~/cc-coco-isolated && grep -vE "^(DATABASE_URL|PORT|DAEMON_GATEWAY_PORT|DAEMON_GATEWAY_PUBLIC|SERVER_PUBLIC_URL|OPEN_TAG_INSTANCE_ROLE|OPEN_TAG_INSTANCE_ID|OPEN_TAG_FEISHU_ACCESS|FEISHU_APP_ID|FEISHU_APP_SECRET|FEISHU_DEV_APP_ID|FEISHU_DEV_APP_SECRET|DAEMON_ARTIFACT_PATH|OPEN_TAG_HOME|WORKSPACES_ROOT)=" ~/OpenClaudeTag/.env > .env && cat >> .env <<EOF
DATABASE_URL=postgresql://open-claude-tag:open-claude-tag@127.0.0.1:5432/openClaudeTag_coco_test
PORT=3300
DAEMON_GATEWAY_PORT=5300
DAEMON_GATEWAY_PUBLIC=false
SERVER_PUBLIC_URL=http://127.0.0.1:5300
OPEN_TAG_INSTANCE_ROLE=isolated
OPEN_TAG_INSTANCE_ID=coco-test
OPEN_TAG_FEISHU_ACCESS=disabled
OPEN_TAG_DEV_AUTH=enabled
FEISHU_APP_ID=cli_coco_isolated_dummy
FEISHU_APP_SECRET=dummy_secret_not_used
OPEN_TAG_HOME=$HOME/.open-claude-tag-coco
WORKSPACES_ROOT=$HOME/.open-claude-tag-coco/workspaces
EOF'

# 1e. migrate + seed the isolated DB, then start API + Worker (setsid survives the ssh exit)
$SSH 'cd ~/cc-coco-isolated && pnpm db:setup && mkdir -p logs &&
  setsid node --env-file=.env apps/api/dist/server.js  >> logs/api.log    2>&1 < /dev/null &
  setsid node --env-file=.env apps/worker/dist/main.js >> logs/worker.log 2>&1 < /dev/null &'

# 1f. verify: API healthy, Feishu disabled, gateway on loopback, coco NOT on the server
$SSH 'curl -s http://127.0.0.1:3300/health | head -c 120; echo;
  grep -E "Daemon gateway listening|Coco runtime not registered" ~/cc-coco-isolated/logs/worker.log | tail -2'
#   → "Daemon gateway listening" host=127.0.0.1 port=5300
#   → "Coco runtime not registered: no coco binary resolvable"   (correct — forces remote)
```

## 2. Daemon: pair the local machine and start it

```bash
# 2a. SSH tunnel: local 5300 → remote host loopback gateway 5300 (keep it running)
ssh -N -o ServerAliveInterval=15 -o ExitOnForwardFailure=yes \
    -L 5300:127.0.0.1:5300 youruser@server.example.com &
curl -s http://127.0.0.1:5300/daemon/health   # → {"ok":true,...} proves the tunnel reaches the gateway

# 2b. issue a one-time pairing token via the isolated server (dev-auth, on the remote host)
$SSH 'J=/tmp/cj; curl -s -c $J -X POST http://127.0.0.1:3300/admin/auth/dev-login -H "Content-Type: application/json" -d "{\"sub\":\"coco-tester\"}" >/dev/null;
  curl -s -b $J -X POST http://127.0.0.1:3300/admin/machines/pairing-token -H "Content-Type: application/json" -d "{\"name\":\"coco-daemon-local\"}"'
# → copy the .token value (10-min TTL, single-use)

# 2c. pair + run the daemon (local). NOTE: the daemon bin entry is dist/index.js (NOT cli.js),
#     and use the TOP-LEVEL one-command form (--server-url/--token) — the `connect` subcommand
#     mis-parses --token because the program also defines a top-level --token.
cd .claude/worktrees/coco
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy   # coco needs direct network access
export PATH="$HOME/.local/bin:$PATH"                  # so the daemon resolves `coco`
node apps/daemon/dist/index.js --server-url http://127.0.0.1:5300 --token <TOKEN> --name coco-daemon-local &
#   config persists to ~/.open-claude-tag/daemon.json (0600). Server logs "Machine paired".

# 2d. confirm the machine is online and advertises coco
$SSH 'J=/tmp/cj; curl -s -b $J http://127.0.0.1:3300/admin/machines'
#   → [{ name:"coco-daemon-local", status:"online", runtimes:["codex","coco"] }]
```

## 2b. Real onboarding via the PUBLISHED registry package (`npx`)

Section 2 runs the local build (`node apps/daemon/dist/index.js`). To validate the **actual
user onboarding** — the connect command the console hands out (`npx @open-tag/daemon@latest …`)
— publish the daemon to your registry and pair via `npx`. Verified once on 2026-06-14.

```bash
# publish a PRERELEASE so the prod @latest tag is never moved (the registry has no unpublish).
cd apps/daemon
node -e "const o=require('./package.json');o.version='0.1.5-coco.0';require('fs').writeFileSync('package.json',JSON.stringify(o,null,2)+'\n')"
npm_config_registry=https://registry.example.com pnpm publish --no-git-checks --tag coco-test --registry https://registry.example.com
node -e "const o=require('./package.json');o.version='0.1.3';require('fs').writeFileSync('package.json',JSON.stringify(o,null,2)+'\n')"   # revert; keep the branch clean
# prepack runs `build:bundle` (tsup) → the published tarball BUNDLES coco-adapter inline.

# pair via the published package (pulls from the registry; --background detaches). Top-level form again.
cd ../.. && export PATH="$HOME/.local/bin:$PATH" && unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy
npm_config_registry=https://registry.example.com npx -y @open-tag/daemon@0.1.5-coco.0 \
  --server-url http://127.0.0.1:5300 --token <TOKEN> --name coco-daemon-npx --background
#   → "Detected runtimes: codex, coco"  ← the published bundle has coco
#   → "Paired successfully. Machine id: …"  → "Daemon started in the background"
#   logs at ~/.open-claude-tag/daemon.log: "Registered CocoAdapter binaryPath=~/.local/bin/coco"
```

Then bind an agent to this machine (section 3) and dispatch — the task runs coco on the
published-package daemon and completes with `runtime_backend=coco`. NOTE: when running multiple
daemons on one host (e.g. a parallel test), isolate the config with `OPEN_TAG_HOME=<dir>` so
they don't clobber the shared `~/.open-claude-tag/daemon.json`.

## 3. End-to-end remote coco task + offline fail-fast

```bash
# 3a. bind an agent to the machine with runtime=coco (handle must be SPACE-FREE for @agent: routing).
#     SET defaultModel on the inline profile — it drives coco `-c model.name=` (and codex `--model`)
#     locally AND over the daemon (the model rides on TaskSpec.model in the dispatch frame). Without
#     it coco falls back to its slow host default (which can return empty). The console agent
#     create/edit form has a "Model" input for the same purpose.
$SSH 'J=/tmp/cj; curl -s -b $J -X POST http://127.0.0.1:3300/admin/agents -H "Content-Type: application/json" \
  -d "{\"displayName\":\"cocoremote\",\"machineId\":\"<MACHINE_ID>\",\"defaultRuntime\":\"coco\",\"profile\":{\"displayName\":\"cocoremote\",\"defaultRuntime\":\"coco\",\"defaultModel\":\"Gemini-3-Flash-Preview\"}}"'

# 3b. trigger a task routed to that agent (virtualAgentHandle prepends @agent:<handle>)
$SSH 'curl -s -X POST http://127.0.0.1:3300/debug/simulate -H "Content-Type: application/json" \
  -d "{\"text\":\"Reply with exactly REMOTE_COCO_OK and nothing else.\",\"virtualAgentHandle\":\"cocoremote\",\"senderOpenId\":\"coco-tester\",\"skipTaskExecution\":false}"'

# 3c. expected server worker log:
#   "Dispatching task to remote machine ... runtime=coco"
#   "Generic agent run deferred to remote daemon"   ← server did NOT run it locally
#   "Starting Coco..." → "SDK session created" → "Task completed successfully"
# task row: status=completed, output.text="REMOTE_COCO_OK", task_runs.runtime_backend=coco

# 3d. D8 fail-fast: stop the daemon, re-trigger → the task FAILS FAST (never silent server-local)
#   kill the local `node apps/daemon/dist/index.js` pid; machine flips to "offline".
#   task error: 'Machine "coco-daemon-local" is offline ... Start your daemon to run this task: ...'
```

## 4. Teardown

```bash
# stop the isolated server by listening port → cwd guard (never a bare pkill)
$SSH 'for p in 3300 5300; do PID=$(ss -tlnp 2>/dev/null | grep ":$p " | grep -oE "pid=[0-9]+" | head -1 | cut -d= -f2);
  [ -n "$PID" ] && readlink /proc/$PID/cwd | grep -q cc-coco-isolated && kill -TERM "$PID"; done'
kill %1 2>/dev/null            # the SSH tunnel
# optional full purge: $SSH 'rm -rf ~/cc-coco-isolated ~/.open-claude-tag-coco ~/cc-coco.bundle' and
#   DROP DATABASE openClaudeTag_coco_test. Verify prod 3000/3001/8080/5432 still UP afterwards.
```
