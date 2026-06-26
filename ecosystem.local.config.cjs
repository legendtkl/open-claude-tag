/* eslint-disable no-undef */
/* eslint-disable @typescript-eslint/no-require-imports */
'use strict';

const path = require('path');
const REPO_ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: 'open-claude-tag-api',
      script: path.join(REPO_ROOT, 'apps/api/dist/server.js'),
      node_args: `--env-file=${path.join(REPO_ROOT, '.env')}`,
      cwd: REPO_ROOT,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      exp_backoff_restart_delay: 100,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '/tmp/open-claude-tag/primary/api.log',
      error_file: '/tmp/open-claude-tag/primary/api.error.log',
      merge_logs: true,
    },
    {
      name: 'open-claude-tag-worker',
      script: path.join(REPO_ROOT, 'apps/worker/dist/main.js'),
      node_args: `--env-file=${path.join(REPO_ROOT, '.env')}`,
      cwd: REPO_ROOT,
      autorestart: true,
      max_restarts: 50,
      restart_delay: 3000,
      exp_backoff_restart_delay: 100,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      out_file: '/tmp/open-claude-tag/primary/worker.log',
      error_file: '/tmp/open-claude-tag/primary/worker.error.log',
      merge_logs: true,
    },
  ],
};
