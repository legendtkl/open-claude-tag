const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const logRoot = path.join(repoRoot, 'logs', 'pm2');

module.exports = {
  apps: [
    {
      name: 'open-claude-tag-api',
      cwd: repoRoot,
      script: 'apps/api/dist/server.js',
      interpreter: 'node',
      node_args: '--env-file=.env',
      autorestart: true,
      min_uptime: '10s',
      max_restarts: 20,
      exp_backoff_restart_delay: 5000,
      kill_timeout: 10000,
      time: true,
      merge_logs: true,
      out_file: path.join(logRoot, 'api.out.log'),
      error_file: path.join(logRoot, 'api.err.log'),
      env: {
        OPEN_TAG_REPO_ROOT: repoRoot,
      },
    },
    {
      name: 'open-claude-tag-worker',
      cwd: repoRoot,
      script: 'apps/worker/dist/main.js',
      interpreter: 'node',
      node_args: '--env-file=.env',
      autorestart: true,
      min_uptime: '10s',
      max_restarts: 20,
      exp_backoff_restart_delay: 5000,
      kill_timeout: 10000,
      time: true,
      merge_logs: true,
      out_file: path.join(logRoot, 'worker.out.log'),
      error_file: path.join(logRoot, 'worker.err.log'),
      env: {
        OPEN_TAG_REPO_ROOT: repoRoot,
      },
    },
    {
      name: 'open-claude-tag-console',
      cwd: path.join(repoRoot, 'apps', 'console'),
      script: 'node',
      args: 'serve-console.mjs',
      interpreter: 'none',
      autorestart: true,
      min_uptime: '10s',
      max_restarts: 20,
      exp_backoff_restart_delay: 5000,
      kill_timeout: 10000,
      time: true,
      merge_logs: true,
      out_file: path.join(logRoot, 'console.out.log'),
      error_file: path.join(logRoot, 'console.err.log'),
      env: {
        API_URL: 'http://127.0.0.1:3000',
        CONSOLE_HOST: '0.0.0.0',
        CONSOLE_PORT: '8080',
      },
    },
  ],
};
