// Minimal static server + API proxy for the OpenClaudeTag admin console (dist build).
// Zero dependencies: serves apps/console/dist and forwards /admin + /health to the API.
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';

const DIST = process.env.CONSOLE_DIST ?? new URL('.', import.meta.url).pathname + 'dist';
const PORT = Number(process.env.CONSOLE_PORT ?? 8080);
const HOST = process.env.CONSOLE_HOST ?? '0.0.0.0';
const API = new URL(process.env.API_URL ?? 'http://127.0.0.1:3000');
const CONSOLE_MARKER_HEADER = 'x-open-claude-tag-console';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function parseRequestTarget(requestTarget) {
  try {
    return new URL(requestTarget ?? '/', 'http://x');
  } catch {
    return undefined;
  }
}

export function createConsoleServer({ dist = DIST, api = API } = {}) {
  const apiUrl = api instanceof URL ? api : new URL(api);

  return createServer((req, res) => {
    const requestTarget = req.url ?? '/';
    const url = parseRequestTarget(requestTarget);
    if (!url) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end('bad request');
      return;
    }

    if (url.pathname.startsWith('/admin') || url.pathname.startsWith('/health')) {
      // Forward the real client address: the admin guard treats loopback sockets
      // as break-glass superadmin, and without XFF every proxied request would
      // reach the API from 127.0.0.1 (live-found privilege escalation).
      const clientIp = req.socket.remoteAddress ?? '';
      const priorXff = req.headers['x-forwarded-for'];
      const xff = priorXff ? `${priorXff}, ${clientIp}` : clientIp;
      const upstream = httpRequest(
        {
          host: apiUrl.hostname,
          port: apiUrl.port,
          path: requestTarget,
          method: req.method,
          headers: {
            ...req.headers,
            host: `${apiUrl.hostname}:${apiUrl.port}`,
            'x-forwarded-for': xff,
            'x-forwarded-proto': 'http',
            'x-forwarded-host': req.headers.host ?? '',
          },
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          up.pipe(res);
        },
      );
      upstream.on('error', () => {
        res.writeHead(502).end('api upstream unavailable');
      });
      req.pipe(upstream);
      return;
    }

    const safePath = normalize(url.pathname).replace(/^\/+/, '') || 'index.html';
    const filePath = join(dist, safePath.includes('..') ? 'index.html' : safePath);
    readFile(filePath)
      .catch(() => readFile(join(dist, 'index.html'))) // SPA fallback
      .then((buf) => {
        res.writeHead(200, {
          'content-type': MIME[extname(filePath)] ?? 'text/html; charset=utf-8',
          [CONSOLE_MARKER_HEADER]: '1',
        });
        res.end(buf);
      })
      .catch(() => res.writeHead(404).end('not found'));
  });
}

function isMainModule() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}

if (isMainModule()) {
  createConsoleServer().listen(PORT, HOST, () => {
    console.log(`console serving ${DIST} on ${HOST}:${PORT}, proxy -> ${API.href}`);
  });
}
