# Server-Centralized Deployment Guide

This guide covers running OpenClaudeTag as a **central server** that serves a whole team, with optional per-user execution daemons. Design rationale and core invariants live in root `AGENTS.md` (§ Server-Centralized Invariants).

## Topology

```
Feishu cloud ◄──WSClient──► API (:3000) ──pg-boss/Postgres──► Worker
                                                              ├─ local runtimes (server-side execution)
                                                              └─ daemon gateway (:3001) ◄──outbound WSS── user daemons
```

- **API**: sole owner of the Feishu WebSocket connection. Never run two stacks against the same Feishu app.
- **Worker**: orchestrates tasks; executes server-local tasks itself and remote tasks through the daemon gateway it hosts on `DAEMON_GATEWAY_PORT` (default 3001).
- **User daemons** (`@open-tag/daemon`): optional, outbound-only clients on user machines. They hold no Feishu or DB credentials.

## Prerequisites

- Docker + Docker Compose (or Node 20 + pnpm 9 for bare-metal).
- A Feishu app (app_id/app_secret) with event subscriptions via long connection.
- Anthropic credentials (`ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN`) and/or a Codex setup (`~/.codex`) for server-side execution.
- A public HTTPS endpoint (reverse proxy) if user daemons must reach the server across networks.

## Quick start (Docker Compose)

```bash
cp .env.example .env   # fill in FEISHU_*, ANTHROPIC_*, SERVER_PUBLIC_URL
docker compose -f infra/docker-compose.yaml up -d --build
curl http://localhost:3000/health
```

The compose file runs Postgres (named volume `pgdata`), API, and Worker. Runtime credentials are mounted from the host (`~/.claude`, `~/.codex`).

## Environment reference (server-mode additions)

| Variable                      | Default                                        | Meaning                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SERVER_PUBLIC_URL`           | — (required for pairing)                       | Public base URL users' daemons dial, e.g. `https://your-server.example.com`. Surfaced via `GET /admin/auth/config` so the console's Machines install guide can substitute it into `--server-url <url>`.                                                                                         |
| `DAEMON_GATEWAY_PORT`         | `3001`                                         | Port the worker's daemon gateway listens on.                                                                                                                                                                                                                                                 |
| `DAEMON_ARTIFACT_PATH`        | —                                              | Absolute path to a packed daemon tarball (`.tgz`). When set, `GET /admin/daemon/artifact` streams it as `open-claude-tag-daemon.tgz` so the console "Download daemon" button works without a published registry. Unset ⇒ the endpoint returns 404 (the install guide still shows the npx method). |
| `DESKTOP_ARTIFACT_PATH_ARM64` | —                                              | Absolute path to the Apple Silicon macOS app DMG. When set, `GET /admin/desktop/artifact?arch=arm64` streams it for direct/scripted downloads. Unset ⇒ the API falls back to standard `apps/desktop/release` discovery before reporting the arch unavailable.                                  |
| `DESKTOP_ARTIFACT_PATH_X64`   | —                                              | Absolute path to the Intel macOS app DMG (`arch=x64`). Same behavior as the arm64 path; each arch is independently optional.                                                                                                                                                                 |
| `DAEMON_GATEWAY_PUBLIC`       | `false`                                        | When `false`, the gateway binds loopback only (localhost mode). Set `true` behind a reverse proxy.                                                                                                                                                                                           |
| `OPEN_TAG_ADMIN_TOKEN`      | —                                              | Break-glass admin-console token (acts as superadmin). Without it, `/admin/*` is loopback-only for unauthenticated requests.                                                                                                                                                                  |
| `OPEN_TAG_DEV_AUTH`           | disabled                                       | Set `enabled` to turn on the local dev-auth login: an operator types an identity to sign in as a real (non-superadmin) `platform_user` — required to mint owner-scoped machine pairing tokens. Off ⇒ the dev-auth endpoints 404 and a forged `cc_dev_user` cookie is ignored.                 |

All existing variables (`DATABASE_URL`, `FEISHU_APP_ID/SECRET`, `WORKER_CONCURRENCY`, ...) keep their meaning; see `.env.example`.

## Reverse proxy

Expose exactly two routes over TLS:

```nginx
# API (Feishu uses outbound WS, so this is for health/admin/debug only — restrict by IP if possible)
location / {
    proxy_pass http://127.0.0.1:3000;
}

# Daemon gateway — WebSocket upgrade required
location /daemon/ {
    proxy_pass http://127.0.0.1:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 120s;   # > heartbeat interval
}
```

TLS termination at the proxy; the gateway itself speaks plain WS internally. Daemons honor `HTTPS_PROXY`/`NO_PROXY` for corp networks.

## Admin console (self-service platform UI)

The console is a static SPA (`apps/console/dist`, built by `pnpm --filter @open-tag/console build`). Host it with any static server that proxies `/admin` and `/health` to the API. Two built-in options:

```bash
# Option A: zero-dependency node server (static + API proxy)
cd apps/console && API_URL=http://127.0.0.1:3000 CONSOLE_PORT=8080 node serve-console.mjs

# Option B: vite preview (CONSOLE_HOST=0.0.0.0 to expose beyond loopback)
cd apps/console && API_URL=http://127.0.0.1:3000 CONSOLE_HOST=0.0.0.0 CONSOLE_PORT=8080 pnpm preview
```

Identity model (design D-A3/D-A6):

- **Break-glass token / loopback (default)**: `OPEN_TAG_ADMIN_TOKEN` set in the server env and entered in the console's Settings → Access panel acts as superadmin (use for ops and raw-IP deployments). Loopback requests are admitted as superadmin without a token. A break-glass superadmin has no `platform_user` row, so it **cannot mint machine pairing tokens** — use dev-auth for that.
- **Local dev-auth (`OPEN_TAG_DEV_AUTH=enabled`)**: an operator types an identity on the login gate to sign in as a real, owner-scoped (non-superadmin) `platform_user`. This is the supported way to obtain a platform identity that can mint owner-scoped machine pairing tokens. It performs **no external authentication** — only enable it on a trusted host.

## Pairing a user machine

1. User opens the admin console's **Machines** page.
2. User clicks **Generate pairing token**. The console returns a one-time token (10 min TTL, single use) embedded in a full command:
   `npm_config_registry=https://registry.example.com npx @open-tag/daemon@latest --server-url https://your-server.example.com --token <token> --background`
3. User runs the command on the machine that should execute tasks.
4. The machine appears online in the console.
5. Bind agents or chats to the machine in the console. Tasks bound to that machine execute there; `self_dev` tasks always stay on the server.

Ownership is closed by default: only the user who paired a machine can bind/unbind/remove it, regardless of `OPEN_ACCESS`.

## Daemon install (Linux/macOS)

The admin console's **Machines** page renders an OS-specific install guide ("Connect a machine / 接入一台机器") with copy buttons and the `--server-url` URL pre-filled from `SERVER_PUBLIC_URL`. The same steps for reference:

**1. Node.js 20+**

- Linux: nvm (`nvm install 20`) or your distro package manager.
- macOS: `brew install node` or nvm.

**2. Pairing token** — on the console's Machines page, click **Generate pairing token**. Use the one-time token (10 min TTL, single use) as `<TOKEN>` below.

**3. Install and start** — two methods:

_Method A — download from this server_ (works before publishing to a registry; requires `DAEMON_ARTIFACT_PATH` set, see below):

```bash
# Download the tarball from the console's "Download daemon" button, or:
curl -fSL "$SERVER_PUBLIC_URL_OR_CONSOLE_ORIGIN/admin/daemon/artifact" -o open-claude-tag-daemon.tgz
npm install -g ./open-claude-tag-daemon.tgz
open-claude-tag-daemon install --server-url <SERVER_PUBLIC_URL> --token <TOKEN> --background
```

_Method B — npx (once published to your registry)_:

```bash
npm_config_registry=https://registry.example.com npx @open-tag/daemon@latest --server-url <SERVER_PUBLIC_URL> --token <TOKEN> --background
```

The no-subcommand npx form intentionally mirrors installers like `npx @your-org/daemon@latest --server-url ... --api-key ...`. OpenClaudeTag also accepts `--api-key <TOKEN>` as an alias for `--token <TOKEN>` in this one-command flow; the value is still the short-lived pairing token, not a long-lived secret.

**4. Manage the background daemon**

```bash
# npx path, matching the recommended installer:
npm_config_registry=https://registry.example.com npx @open-tag/daemon@latest status
npm_config_registry=https://registry.example.com npx @open-tag/daemon@latest stop
npm_config_registry=https://registry.example.com npx @open-tag/daemon@latest start --background

# globally installed tarball path:
open-claude-tag-daemon status
open-claude-tag-daemon stop
open-claude-tag-daemon start --background
```

- Linux systemd **user** unit alternative:
  ```ini
  # ~/.config/systemd/user/open-claude-tag-daemon.service
  [Unit]
  Description=OpenClaudeTag daemon
  [Service]
  ExecStart=%h/.local/bin/open-claude-tag-daemon start
  Restart=on-failure
  [Install]
  WantedBy=default.target
  ```
  `systemctl --user enable --now open-claude-tag-daemon`.
- macOS launchd alternative:
  ```xml
  <!-- ~/Library/LaunchAgents/com.open-claude-tag.daemon.plist -->
  <plist version="1.0"><dict>
    <key>Label</key><string>com.open-claude-tag.daemon</string>
    <key>ProgramArguments</key><array>
      <string>/usr/local/bin/open-claude-tag-daemon</string><string>start</string>
    </array>
    <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  </dict></plist>
  ```
  `launchctl load ~/Library/LaunchAgents/com.open-claude-tag.daemon.plist`.

### Producing the downloadable tarball

The download button (`GET /admin/daemon/artifact`) streams whatever `DAEMON_ARTIFACT_PATH` points at. The deploy must build it once and point the env at it:

```bash
pnpm --filter @open-tag/daemon run pack:tgz   # runs prepack (clean + bundle) then `npm pack`
# → apps/daemon/open-claude-tag-daemon-<version>.tgz
export DAEMON_ARTIFACT_PATH="$PWD/apps/daemon/open-claude-tag-daemon-<version>.tgz"
```

If `DAEMON_ARTIFACT_PATH` is unset (or the file is missing), the endpoint returns 404 with a JSON hint and the console install guide still works via the npx method.

### Producing the optional macOS app (DMG)

The web console no longer exposes a standalone Downloads page, but the API keeps
the guarded desktop artifact endpoint for operators who distribute the macOS
console app directly: `GET /admin/desktop/artifact?arch=arm64|x64`. The DMG is
an Electron build that must be produced **on a Mac** (Linux/devbox hosts cannot
build or sign it), then copied to the server. This is a post-merge ops step,
like publishing the daemon:

```bash
# 1. On a Mac, build (and ideally sign + notarize) the DMG from the repo root:
pnpm dist:desktop:mac           # or dist:desktop:mac:signed with Apple Developer creds
# → apps/desktop/release/OpenClaudeTag Console-<version>-arm64.dmg (and -x64 if built)

# 2. Copy the DMG(s) to the server (scp, etc.), e.g. ~/artifacts/.
#    If the server runs from the same checkout and the DMG remains under
#    apps/desktop/release/, the API auto-discovers it and these env vars are optional.

# 3. On the server, point the env at the placed file(s) and restart the API:
export DESKTOP_ARTIFACT_PATH_ARM64="$HOME/artifacts/OpenClaudeTag Console-<version>-arm64.dmg"
export DESKTOP_ARTIFACT_PATH_X64="$HOME/artifacts/OpenClaudeTag Console-<version>-x64.dmg"   # optional
```

Each arch is independently optional: ship arm64 first and leave
`DESKTOP_ARTIFACT_PATH_X64` unset until an Intel build exists. The packaged app
defaults its API target to the central server (`http://your-server.example.com:3000`);
override the baked-in default at build/run time with
`OPEN_TAG_DESKTOP_DEFAULT_API_URL`.

## Operations

- **Upgrade**: `git pull && docker compose -f infra/docker-compose.yaml up -d --build`. The daemon protocol is version-negotiated; incompatible daemons receive an upgrade hint and users re-run `npx @open-tag/daemon@latest`.
- **Backup**: Postgres is the only state that matters (sessions, tasks, machines, queue); workspaces/worktrees on the server are reproducible. Docker deployments: `pg_dump` the `pgdata` named volume on a schedule. Bare-host deployments on embedded Postgres **cannot use pg_dump** — see "Day-2 ops on a bare host" in the runbook below.
- **Health**: `GET /health` covers DB, queue, worker, Feishu WS. The worker heartbeat includes gateway status. `machines.last_seen_at` drives `/machine list` freshness.
- **Revocation**: `/machine remove <name>` revokes credentials and closes the connection immediately.
- **Logs**: container stdout (pino JSON); `docker compose logs -f api worker`.

## Failure behavior users will see

| Situation                         | Behavior                                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Bound machine offline at dispatch | Task fails immediately; card names the machine, last-seen time, and how to start the daemon              |
| Daemon network flap mid-task      | Invisible if shorter than 120 s (events are replayed); otherwise the task fails with a disconnect reason |
| Daemon process restarted mid-task | Task fails immediately with a daemon-restart reason                                                      |
| Stale daemon version              | Connection refused with an upgrade hint card/CLI message                                                 |

## Localhost mode

Nothing changes. Running API + Worker on one machine with the gateway bound to loopback is exactly the previous behavior; remote machines are an opt-in layer on top.

---

## Deployment runbook (bare server / devbox, no Docker)

This is the exact procedure used to stand the central server up on a bare host (e.g. a cloud VM) without Docker — Postgres from the `@embedded-postgres` binary or a host Postgres, plus three Node processes (API, Worker, Console). Compose (above) is the turnkey alternative; this runbook is for hosts where Docker images are unreachable.

### 0. Host prerequisites

- Node 20+ and pnpm 9 (`corepack enable && corepack prepare pnpm@9.15.4 --activate`).
- A reachable Postgres. On a host without Docker, the simplest is the prebuilt binary: `npm i @embedded-postgres/linux-x64 --registry=https://registry.example.com` then `initdb`/`pg_ctl` a cluster on `127.0.0.1:5432` with role `open-claude-tag`. (We did exactly this on the devbox; see "Embedded Postgres" below.)
- Internet egress to `open.feishu.cn` (Feishu API) and the npm registry `https://registry.example.com`.

### 1. Get the code onto the host

On a host that cannot `git clone` the repo, ship a bundle:

```bash
# on your machine (inside the repo/worktree)
git bundle create /tmp/cc.bundle HEAD
# copy it over (scp, etc.), then on the host:
mkdir -p ~/OpenClaudeTag && cd ~/OpenClaudeTag && git init -q .
git fetch -q /path/to/cc.bundle HEAD && git checkout -q FETCH_HEAD
```

To **update** an existing checkout: `git fetch -q /path/to/cc.bundle HEAD && git checkout -q FETCH_HEAD`.

### 2. Configure `.env`

Copy `.env.example` → `.env` and set at minimum `DATABASE_URL`, `FEISHU_APP_ID`/`FEISHU_APP_SECRET` (the bot this server owns — never the same app as another running stack), `SERVER_PUBLIC_URL` (the daemon-gateway URL users dial), and your chosen auth mode (see "Authentication modes"). For a control-plane-only server (all execution on user daemons) you may omit runtime creds (`ANTHROPIC_*`, codex) entirely.

### 3. Install + build

```bash
npm_config_registry=https://registry.example.com pnpm install --no-frozen-lockfile
NODE_OPTIONS=--max-old-space-size=2048 pnpm -r --filter '!@open-tag/desktop' build
```

> **Incremental-cache trap:** after pulling code that changed `packages/storage`, delete stale build info before rebuilding or `tsc` may emit nothing: `find packages apps -name '*.tsbuildinfo' -delete`. Symptom: a downstream package fails with "Cannot find module '@open-tag/storage'" or a renamed export is missing at runtime.

### 4. Database (migrate / reset)

Fresh install: `pnpm db:setup` (creates DB if needed, runs all migrations, seeds).

> **Migration reset on upgrade:** migrations are append-only and tracked by hash. If a branch **renumbered** migrations (this happened when `server-centralized-daemon` rebased onto a `main` that also added an `0018_*`), an existing DB will fail `drizzle-kit migrate` with "column already exists". A dev/test DB should be **dropped and recreated** so all migrations apply fresh:
>
> ```bash
> # stop API+Worker first to release connections, then:
> psql "$ADMIN_DATABASE_URL" -c 'DROP DATABASE IF EXISTS open-claude-tag WITH (FORCE); CREATE DATABASE open-claude-tag;'
> pnpm db:setup
> ```
>
> Production DBs with real data must instead reconcile the migration journal by hand — do not blind-reset.

### 5. Start the three processes under a supervisor

Production and shared devbox hosts should run API, Worker, and Console under a supervisor so a process crash is automatically restarted. The repo ships a PM2 process file for bare hosts; it starts the API and Worker from built `dist/` output with `.env`, and starts the console static server on `0.0.0.0:8080` with `/admin` and `/health` proxied to `127.0.0.1:3000`:

```bash
mkdir -p logs/pm2
pnpm exec pm2 start tools/ops/pm2.config.cjs
pnpm exec pm2 save
pnpm exec pm2 status
```

To move an existing bare `setsid` deployment on ports 3000/3001/8080 into PM2 without using fragile `pkill -f` patterns, run:

```bash
bash tools/ops/switch-to-pm2.sh
```

If the host supports user-level autostart, run the command printed by `pnpm exec pm2 startup` and then `pnpm exec pm2 save`. On locked-down devboxes where startup hooks are unavailable, add a user crontab entry instead:

```cron
@reboot cd $HOME/OpenClaudeTag && pnpm exec pm2 resurrect >> $HOME/ops/pm2-resurrect.log 2>&1
```

Manual `setsid` startup is only a fallback when PM2/systemd is unavailable. Append (`>>`) rather than truncate (`>`) the logs — you keep the previous run's tail after a crash, and size-capping (see "Day-2 ops") stays safe with `O_APPEND` writers:

```bash
setsid node --env-file=.env apps/api/dist/server.js    >> logs/api.log    2>&1 < /dev/null &
setsid node --env-file=.env apps/worker/dist/main.js   >> logs/worker.log 2>&1 < /dev/null &
# Console (static SPA + /admin,/health proxy):
( cd apps/console && API_URL=http://127.0.0.1:3000 CONSOLE_HOST=0.0.0.0 CONSOLE_PORT=8080 \
    setsid node serve-console.mjs >> ../../logs/console.log 2>&1 < /dev/null & )

# If the public service domain points directly at this host but the console
# process listens on 8080, expose the HTTP origin on port 80 without requiring
# users to type :8080. Use a real reverse proxy/TLS terminator in production when
# available.
sudo iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 8080 2>/dev/null \
  || sudo iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-ports 8080
```

Health checks:

```bash
curl http://127.0.0.1:3000/health                       # API: {"status":"ok",...}
pnpm exec pm2 logs open-claude-tag-worker --lines 50 --nostream | grep 'Daemon gateway listening'   # gateway up THIS run
curl http://127.0.0.1:8080/admin/auth/config            # Console reachable + auth mode
curl http://your-server.example.com/admin/auth/config      # Registered domain reaches console without :8080
```

(Don't `grep -c` the whole worker log for the gateway line — with append-mode logs the count grows across restarts and proves nothing about the current process.)

External health probe + Feishu alert:

```bash
# Sends to a user email. Use ALERT_CHAT_ID or receive_id_type=chat_id for a group.
OPEN_TAG_HEALTH_ALERT_RECEIVE_ID_TYPE=email \
OPEN_TAG_HEALTH_ALERT_RECEIVE_ID=operator@example.com \
OPEN_TAG_HEALTH_PROBES='api=http://127.0.0.1:3000/health,console=http://127.0.0.1:8080/admin/auth/config' \
pnpm ops:health-alert --dry-run
```

Schedule it from cron once the dry run looks right:

```cron
* * * * cd $HOME/OpenClaudeTag && OPEN_TAG_HEALTH_ALERT_RECEIVE_ID_TYPE=email OPEN_TAG_HEALTH_ALERT_RECEIVE_ID=operator@example.com OPEN_TAG_HEALTH_PROBES='api=http://127.0.0.1:3000/health,console=http://127.0.0.1:8080/admin/auth/config' pnpm ops:health-alert >> $HOME/logs/health-alert.log 2>&1
```

`tools/ops/service-health-alert.mjs` reads `.env` for `FEISHU_APP_ID` / `FEISHU_APP_SECRET`, treats non-2xx responses and JSON health bodies with `status != "ok"` as failures, rate-limits repeated down alerts with `OPEN_TAG_HEALTH_ALERT_COOLDOWN_MS` (default 1 hour), and sends a recovery alert when all probes recover. Keep it outside the API process; otherwise API crashes cannot page anyone.

The host-local cron probe should check loopback endpoints. Do not include the registered public domain in a cron running on the same host when port 80 is implemented with a PREROUTING redirect to 8080: locally originated requests do not traverse that NAT path and can false-alert. Check the public domain from an outside workstation or an external uptime monitor.

### Re-deploying (common pitfalls)

- **Never put a `pkill -f`/`pgrep -f` pattern on an ssh command line.** The remote shell's own cmdline contains the pattern, so `ssh host 'pkill -f apps/api/dist/server.js; …'` kills the ssh session itself mid-script — services die half-restarted (this killed a real deploy: API down, stale worker/console still up). Keep kill/restart logic in a script **file on the host** (e.g. `~/ops/restart-stack.sh`) and invoke it by path; a script file's text never appears in any process cmdline. The same self-match applies to `pgrep -f | wc -l` style verification — prefer `pgrep -af … | grep -v pgrep`.
- **Stop services before dropping the DB** — open API/Worker connections block `DROP DATABASE` ("being accessed by other users"; use `WITH (FORCE)` only after killing them).
- **Confirm processes actually restarted**, not just rebuilt: compare `ps -o lstart= -p $(pgrep -f apps/api/dist/server.js)` against the `dist` mtime. A deploy script that aborts mid-way (e.g. `set -e` on a failed step) can leave the OLD process running against new code on disk.
- A bound machine whose daemon is offline makes a task fail fast (by design) — that is not a deploy failure.

### Embedded Postgres (Docker-less hosts)

```bash
mkdir -p ~/pgruntime && cd ~/pgruntime && npm init -y
npm i @embedded-postgres/linux-x64 --registry=https://registry.example.com
BIN=node_modules/@embedded-postgres/linux-x64/native/bin
$BIN/initdb -D ~/pgdata -U open-claude-tag --auth=md5 --pwfile=<(echo open-claude-tag)
$BIN/pg_ctl -D ~/pgdata -l ~/pgdata/server.log -o "-p 5432 -k /tmp" start
```

The package ships **only** `initdb`/`pg_ctl`/`postgres` — no `psql`, no `pg_dump`. Distro client packages are usually too old for the bundled server (e.g. Debian 10 ships pg 11 clients; the bundle is pg 18 — `pg_dump` refuses cross-major). For ad-hoc SQL, run a Node one-liner against the repo's own driver: `cd packages/storage && node -e '…require("postgres")…'`. For backups, see below. Durability defaults are safe (`fsync`/`full_page_writes` on, `max_wal_size=1GB` caps WAL) — leave them alone.

### Day-2 ops on a bare host (autostart, monitoring, backup, disk guards)

A `pg_ctl`-started cluster and unsupervised Node processes have no reboot recovery, external alerting, backups, or log caps. PM2 covers process crash restarts for the Node services; one user crontab still covers reboot restore on locked-down hosts, health probing, backups, and disk guards (reference implementation: `~/ops/*` on the bare-host deployment):

```cron
@reboot sleep 20 && cd $HOME/OpenClaudeTag && pnpm exec pm2 resurrect >> $HOME/ops/pm2-resurrect.log 2>&1
* * * * cd $HOME/OpenClaudeTag && pnpm ops:health-alert >> $HOME/logs/health-alert.log 2>&1
0 * * * * bash $HOME/ops/log-cap.sh
30 4 * * * bash $HOME/ops/pg-backup.sh
*/30 * * * * /usr/bin/node $HOME/ops/disk-alert.mjs >> $HOME/.disk-alert.log 2>&1
```

- **PM2 supervisor** (`tools/ops/pm2.config.cjs`): auto-restarts API/Worker/Console after crashes and keeps per-process logs under `logs/pm2/`. Use `pnpm exec pm2 restart tools/ops/pm2.config.cjs --update-env` after changing `.env`, and `pnpm exec pm2 save` after changing the process list. If PM2 is unavailable, keep a `start-services.sh` fallback with `pg_ctl status || pg_ctl start`, the idempotent `iptables` redirect from step 5, and guarded `setsid` starts exactly as above.
- **`service-health-alert.mjs`** (every minute): host-local liveness probe for API and console loopback endpoints. It reads `.env` for Feishu app credentials and sends text alerts to `OPEN_TAG_HEALTH_ALERT_RECEIVE_ID` (or `ALERT_CHAT_ID`) using `OPEN_TAG_HEALTH_ALERT_RECEIVE_ID_TYPE=email|chat_id|open_id`. State is stored in `~/.open-claude-tag-health-alert-state.json`, so repeated down alerts are rate-limited and recovery alerts are sent once. Public-domain reachability should be checked from outside the host when port 80 is implemented through local NAT.
- **`pg-backup.sh`** (nightly): **cold backup** — `pg_ctl stop -m fast` → `tar czf ~/pgbackups/pgdata-<ts>.tar.gz ~/pgdata` → `pg_ctl start`; keep the last N (e.g. 7). With a control-plane-sized DB (tens of MB) downtime is 2–3 s; postgres.js pools and pg-boss reconnect on their own. This is the _only_ workable scheme on embedded Postgres (no `pg_dump`, see above), and restore is a plain untar of `~/pgdata`. If the stop fails, start pg back and skip the backup — never tar a running cluster. Periodically copy the newest tarball **off the host**: the host itself (a personal devbox) can be reclaimed.
- **`log-cap.sh`** (hourly): error-storm guard — for each unbounded log (`logs/*.log`, `~/pgdata/server.log`), once it passes a cap (e.g. 200 MB) keep only the last 10 MB: `tail -c 10485760 "$f" > "$f.tmp" && cat "$f.tmp" > "$f"`. Safe while writers hold the fd because all writers are `O_APPEND` (`>>` redirects and `pg_ctl -l`). Steady-state growth is harmless (~hundreds of KB/day); a crash-loop spewing gigabytes per day is the case this exists for.
- **`disk-alert.mjs`** (every 30 min): `df` the data and root mounts; above a threshold (80%), page the operator. The server's own Feishu bot credentials in `.env` work for this — `tenant_access_token` + `POST /open-apis/im/v1/messages?receive_id_type=email` to the operator's email, rate-limited to one alert per few hours via a state file.

## Authentication modes (admin console)

The console guard resolves identity in this order: **dev-auth cookie (if enabled) → break-glass loopback/token → 403**. Pick the mode per deployment:

| Mode                     | Env                                                                   | Who can sign in                                                                            | When to use                                                                    |
| ------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| **Dev-auth**             | `OPEN_TAG_DEV_AUTH=enabled` (default OFF)                           | anyone, by typing an identity — **no external auth**; works on a raw IP. Always a non-superadmin `platform_user`, so it can mint owner-scoped pairing tokens | the supported way to hold a real platform identity (machine pairing); only on a trusted host |
| **Break-glass token**    | `OPEN_TAG_ADMIN_TOKEN=<secret>`                                     | holder of the token → superadmin (no `platform_user` row, so cannot mint pairing tokens)   | ops / raw-IP deployments / recovery                                            |
| **Loopback**             | — (default)                                                           | any request from `127.0.0.1`/`::1` → superadmin                                            | local development                                                              |

Ownership is per-creator and fail-closed: a plain (dev-auth) user only sees/mutates their own feishu_apps, agents, machines, profiles, and the chats where they own an agent (superadmin sees all).

## Onboarding flow (what a user does)

1. Open the console, sign in (dev-auth / token / loopback).
2. **Machines page → "Generate pairing token"** → copy the one-command `npx @open-tag/daemon@latest --server-url … --token … --background` installer (server URL pre-filled) and run it on your machine. The machine appears under your account, online. (No Feishu `/machine` command — pairing is console-only, design D-A7.)
3. **Bots page** → register your Feishu bot (app_id/secret). **Agents page** → create an agent, **select which of your machines it runs on** (design D-A8), bound to your bot.
4. In Feishu, `@` your bot — tasks route to that agent's machine (precedence: per-turn → agent machine → session → chat default → server-local; `self_dev` always server-local).

## Publishing the daemon

Users install the daemon via `npm_config_registry=https://registry.example.com npx @open-tag/daemon@latest …` (drop the `npm_config_registry=` prefix when publishing to the public npm registry). To (re)publish after a change:

```bash
# one-time: register the @open-tag scope on your registry
npm login --registry=https://registry.example.com           # then: npm whoami --registry=https://registry.example.com
cd apps/daemon && pnpm publish --registry=https://registry.example.com --no-git-checks   # bump version first
```

`pnpm publish` runs the tsup `prepack` (bundles workspace deps into `dist`) and rewrites the `workspace:*` devDeps; the published `dependencies` are all public packages the registry mirrors. The console install guide also offers a tarball fallback served from `GET /admin/daemon/artifact` (gated by `DAEMON_ARTIFACT_PATH`, produced by `pnpm --filter @open-tag/daemon run pack:tgz`).
