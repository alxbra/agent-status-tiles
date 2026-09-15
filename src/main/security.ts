import type { BrowserWindow } from 'electron';

export function isAllowedRendererNavigation(targetUrl: string, rendererUrl: string): boolean {
  try {
    const target = new URL(targetUrl);
    const renderer = new URL(rendererUrl);

    if (target.username || target.password || target.protocol !== renderer.protocol) {
      return false;
    }

    if (renderer.protocol === 'file:') {
      return target.host === renderer.host && target.pathname === renderer.pathname;
    }

    return target.host === renderer.host;
  } catch {
    return false;
  }
}

/** Apply the renderer's navigation and window-creation boundary to a window. */
export function protectWebContents(window: BrowserWindow, allowedUrl: string): void {
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, allowedUrl)) {
      event.preventDefault();
    }
  });
  window.webContents.on('will-redirect', (event, targetUrl) => {
    if (!isAllowedRendererNavigation(targetUrl, allowedUrl)) {
      event.preventDefault();
    }
  });
  window.webContents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });
}
