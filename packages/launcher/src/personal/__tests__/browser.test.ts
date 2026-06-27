import { describe, expect, it, vi } from 'vitest';
import { openBrowser } from '../browser.js';

describe('openBrowser', () => {
  it('uses `open` on darwin', () => {
    const open = vi.fn();
    openBrowser('http://x', { platform: 'darwin', open });
    expect(open).toHaveBeenCalledWith('open', ['http://x']);
  });

  it('uses `xdg-open` on linux', () => {
    const open = vi.fn();
    openBrowser('http://x', { platform: 'linux', open });
    expect(open).toHaveBeenCalledWith('xdg-open', ['http://x']);
  });

  it('uses `start` on win32', () => {
    const open = vi.fn();
    openBrowser('http://x', { platform: 'win32', open });
    expect(open).toHaveBeenCalledWith('cmd', ['/c', 'start', '', 'http://x']);
  });

  it('never throws when the opener fails', () => {
    const open = vi.fn(() => {
      throw new Error('no display');
    });
    expect(() => openBrowser('http://x', { platform: 'linux', open })).not.toThrow();
  });
});
