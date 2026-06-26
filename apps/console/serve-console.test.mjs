import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { createConsoleServer } from './serve-console.mjs';

const servers = [];
const tempDirs = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
    ),
  );
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function createDist() {
  const dir = await mkdtemp(join(tmpdir(), 'open-claude-tag-console-'));
  tempDirs.push(dir);
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>OpenClaudeTag</title>');
  return dir;
}

async function listen(server) {
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected TCP server address');
  }
  return address.port;
}

async function rawHttpRequest(port, request) {
  return await new Promise((resolve, reject) => {
    const socket = new Socket();
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
    socket.connect(port, '127.0.0.1', () => socket.end(request));
  });
}

describe('console static server', () => {
  it('rejects a malformed request target without terminating the server', async () => {
    const dist = await createDist();
    const port = await listen(createConsoleServer({ dist }));

    const malformedResponse = await rawHttpRequest(
      port,
      'GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n',
    );
    expect(malformedResponse).toMatch(/^HTTP\/1\.1 400 Bad Request/);

    const validResponse = await fetch(`http://127.0.0.1:${port}/still-available`);
    expect(validResponse.status).toBe(200);
    expect(await validResponse.text()).toContain('OpenClaudeTag');
  });
});
