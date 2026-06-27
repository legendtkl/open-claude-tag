import { createRequire } from 'module';

const requireFromHere = createRequire(import.meta.url);

export interface BrowserOps {
  platform?: NodeJS.Platform;
  /** Launch a detached command; must not throw on failure (best-effort). */
  open?: (command: string, args: string[]) => void;
  log?: (message: string) => void;
}

/**
 * Best-effort browser open. NEVER throws — failing to find a browser must not
 * fail `up`. Picks the platform opener (`open` / `start` / `xdg-open`).
 */
export function openBrowser(url: string, ops: BrowserOps = {}): void {
  const platform = ops.platform ?? process.platform;
  const log = ops.log ?? (() => {});

  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }

  try {
    if (ops.open) {
      ops.open(command, args);
    } else {
      // Lazy import keeps this module trivially unit-testable via the `open` dep.
      const { spawn } = requireFromHere('child_process') as typeof import('child_process');
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.on('error', () => {});
      child.unref();
    }
    log(`opened browser at ${url}`);
  } catch {
    log(`could not open a browser automatically; visit ${url}`);
  }
}
