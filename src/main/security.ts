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
