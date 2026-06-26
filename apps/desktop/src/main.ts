import { app, BrowserWindow, ipcMain, Menu, protocol, session, shell } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_SCHEME = 'open-claude-tag-console';
const APP_HOST = 'app';
const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;
const PRODUCT_FULL_NAME = 'OpenClaudeTag Console';
const LEGACY_PRODUCT_FULL_NAME = 'OpenClaudeTag Console';
// Baked-in default API target: the central OpenClaudeTag server (devbox). A freshly
// installed app connects here without manual setup. The dedicated
// OPEN_TAG_DESKTOP_DEFAULT_API_URL env overrides ONLY this default tier (never
// the higher-precedence OPEN_TAG_API_URL / API_URL env or saved Settings), so
// the baked-in target can move to a registered domain later without a code change.
const FALLBACK_DEFAULT_API_URL = 'http://10.37.206.226:3000';
const API_PATH_PREFIXES = ['/admin', '/health'];
const CONFIG_FILE = 'desktop-config.json';
const IPC_GET_CONFIG = 'desktop:get-config';
const IPC_SET_API_URL = 'desktop:set-api-url';
const IPC_RESET_API_URL = 'desktop:reset-api-url';
const STATIC_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join('; ');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type ApiUrlSource = 'saved' | 'environment' | 'default';

interface DesktopConfig {
  apiUrl?: string;
}

interface DesktopConfigPayload {
  apiUrl: string;
  configPath: string;
  defaultApiUrl: string;
  source: ApiUrlSource;
}

let desktopConfig: DesktopConfig = {};

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);

function configPath(): string {
  return path.join(app.getPath('userData'), CONFIG_FILE);
}

function legacyConfigPath(): string {
  return path.join(app.getPath('appData'), LEGACY_PRODUCT_FULL_NAME, CONFIG_FILE);
}

function configureUserDataPath(): void {
  const userDataDir = process.env.OPEN_TAG_DESKTOP_USER_DATA_DIR;
  if (userDataDir) {
    app.setPath('userData', path.resolve(userDataDir));
    return;
  }
  app.setPath('userData', path.join(app.getPath('appData'), PRODUCT_FULL_NAME));
}

function normalizeApiUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('API URL is required.');
  }

  const url = new URL(trimmed);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('API URL must use http or https.');
  }
  url.hash = '';
  url.search = '';

  return formatApiUrl(url);
}

function formatApiUrl(url: URL): string {
  const formatted = url.toString();
  if (url.pathname === '/' && !url.search && !url.hash) {
    return formatted.replace(/\/$/, '');
  }
  return formatted.replace(/\/+$/, '');
}

function resolveDefaultApiUrl(): string {
  const override = process.env.OPEN_TAG_DESKTOP_DEFAULT_API_URL?.trim();
  if (override) {
    try {
      return normalizeApiUrl(override);
    } catch (err) {
      console.warn(
        'Ignoring invalid OPEN_TAG_DESKTOP_DEFAULT_API_URL:',
        (err as Error).message,
      );
    }
  }
  return FALLBACK_DEFAULT_API_URL;
}

function configuredApiUrl(): { source: ApiUrlSource; value: string } {
  const environmentUrl = process.env.OPEN_TAG_API_URL ?? process.env.API_URL;
  if (environmentUrl) {
    return { source: 'environment', value: normalizeApiUrl(environmentUrl) };
  }

  if (desktopConfig.apiUrl) {
    return { source: 'saved', value: desktopConfig.apiUrl };
  }

  return { source: 'default', value: resolveDefaultApiUrl() };
}

function apiBaseUrl(): URL {
  return new URL(configuredApiUrl().value);
}

function apiTargetUrl(baseUrl: URL, requestUrl: URL): URL {
  const target = new URL(baseUrl.toString());
  const basePath = target.pathname.replace(/\/+$/, '');
  target.pathname = `${basePath}${requestUrl.pathname}`.replace(/\/{2,}/g, '/');
  target.search = requestUrl.search;
  target.hash = '';
  return target;
}

function desktopConfigPayload(): DesktopConfigPayload {
  const configured = configuredApiUrl();
  return {
    apiUrl: configured.value,
    configPath: configPath(),
    defaultApiUrl: resolveDefaultApiUrl(),
    source: configured.source,
  };
}

async function readDesktopConfig(): Promise<DesktopConfig> {
  const readConfigAt = async (filePath: string, label: string): Promise<DesktopConfig | null> => {
    try {
      const body = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(body) as { apiUrl?: unknown };
      if (typeof parsed.apiUrl === 'string') {
        return { apiUrl: normalizeApiUrl(parsed.apiUrl) };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`Ignoring invalid ${label} desktop config:`, (err as Error).message);
      }
    }
    return null;
  };

  const currentConfig = await readConfigAt(configPath(), 'current');
  if (currentConfig) return currentConfig;

  const legacyConfig = await readConfigAt(legacyConfigPath(), 'legacy');
  if (legacyConfig) {
    await writeDesktopConfig(legacyConfig);
    return legacyConfig;
  }

  return {};
}

async function writeDesktopConfig(config: DesktopConfig): Promise<void> {
  await mkdir(path.dirname(configPath()), { recursive: true });
  await writeFile(configPath(), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

function registerDesktopIpc(): void {
  ipcMain.handle(IPC_GET_CONFIG, () => desktopConfigPayload());
  ipcMain.handle(IPC_SET_API_URL, async (_event, value: unknown) => {
    if (typeof value !== 'string') {
      throw new Error('API URL must be a string.');
    }
    desktopConfig = { apiUrl: normalizeApiUrl(value) };
    await writeDesktopConfig(desktopConfig);
    return desktopConfigPayload();
  });
  ipcMain.handle(IPC_RESET_API_URL, async () => {
    desktopConfig = {};
    await rm(configPath(), { force: true });
    return desktopConfigPayload();
  });
}

function consoleRoot(): string {
  if (process.env.OPEN_TAG_CONSOLE_DIST) {
    return path.resolve(process.env.OPEN_TAG_CONSOLE_DIST);
  }
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'console');
  }
  return path.resolve(__dirname, '../../console/dist');
}

function isApiPath(pathname: string): boolean {
  return API_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

function mimeType(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  const types: Record<string, string> = {
    '.css': 'text/css; charset=utf-8',
    '.gif': 'image/gif',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  };
  return types[extension] ?? 'application/octet-stream';
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function staticHeaders(filePath: string): HeadersInit {
  return {
    'Content-Type': mimeType(filePath),
    'Content-Security-Policy': STATIC_CSP,
    'Cache-Control': filePath.endsWith('index.html')
      ? 'no-store'
      : 'public, max-age=31536000, immutable',
  };
}

function filePathForRequest(url: URL): string | null {
  const root = consoleRoot();
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const decodedPathname = decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.join(root, decodedPathname);
  const relativePath = path.relative(root, filePath);
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    return null;
  }
  return filePath;
}

async function serveStatic(url: URL): Promise<Response> {
  const filePath = filePathForRequest(url);
  if (!filePath) {
    return new Response('Not found', { status: 404 });
  }

  try {
    const body = await readFile(filePath);
    return new Response(body, {
      status: 200,
      headers: staticHeaders(filePath),
    });
  } catch (err) {
    const fallbackPath = path.join(consoleRoot(), 'index.html');
    if (filePath !== fallbackPath && !path.extname(filePath)) {
      try {
        const body = await readFile(fallbackPath);
        return new Response(body, {
          status: 200,
          headers: staticHeaders(fallbackPath),
        });
      } catch {
        return jsonResponse(
          { error: 'Console build is missing. Run pnpm build:desktop first.' },
          500,
        );
      }
    }

    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return new Response('Not found', { status: 404 });
    }
    return jsonResponse({ error: 'Failed to read console asset.' }, 500);
  }
}

async function proxyApiRequest(request: Request, url: URL): Promise<Response> {
  const baseUrl = apiBaseUrl();
  const target = apiTargetUrl(baseUrl, url);
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.delete('origin');
  headers.delete('referer');

  try {
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : await request.arrayBuffer();
    return await fetch(target, {
      method: request.method,
      headers,
      body,
    });
  } catch (err) {
    return jsonResponse(
      {
        error: `Unable to reach OpenClaudeTag API at ${formatApiUrl(baseUrl)}: ${(err as Error).message}`,
      },
      502,
    );
  }
}

function registerConsoleProtocol(): void {
  protocol.handle(APP_SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.hostname !== APP_HOST) {
      return new Response('Not found', { status: 404 });
    }
    if (isApiPath(url.pathname)) {
      return proxyApiRequest(request, url);
    }
    return serveStatic(url);
  });
}

function isExternalHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:';
  } catch {
    return false;
  }
}

function isInternalNavigation(value: string): boolean {
  if (process.env.OPEN_TAG_CONSOLE_DEV_SERVER_URL) {
    return value.startsWith(process.env.OPEN_TAG_CONSOLE_DEV_SERVER_URL);
  }
  try {
    const url = new URL(value);
    return url.protocol === `${APP_SCHEME}:` && url.hostname === APP_HOST;
  } catch {
    return false;
  }
}

async function openExternalUrl(value: string): Promise<void> {
  if (isExternalHttpUrl(value)) {
    await shell.openExternal(value);
  }
}

function installSecurityHandlers(window: BrowserWindow): void {
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternalUrl(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, navigationUrl) => {
    if (isInternalNavigation(navigationUrl)) {
      return;
    }
    event.preventDefault();
    void openExternalUrl(navigationUrl);
  });
}

function installMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: 'Window',
      submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function createWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 1040,
    minHeight: 680,
    title: PRODUCT_FULL_NAME,
    backgroundColor: '#f7f7f2',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
      webSecurity: true,
    },
  });

  installSecurityHandlers(mainWindow);
  mainWindow.once('ready-to-show', () => mainWindow.show());

  const devServerUrl = process.env.OPEN_TAG_CONSOLE_DEV_SERVER_URL;
  await mainWindow.loadURL(devServerUrl ?? APP_URL);
}

app.whenReady().then(async () => {
  configureUserDataPath();
  app.setName(PRODUCT_FULL_NAME);
  desktopConfig = await readDesktopConfig();
  registerDesktopIpc();
  registerConsoleProtocol();
  installMenu();
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
