/** Native Electron tests can activate windows and change the foreground app. */
export function nativeElectronE2eEnabled(): boolean {
  return (
    process.env.GITHUB_ACTIONS === 'true' || process.env.AGENT_STATUS_TILES_ALLOW_FOCUS_E2E === '1'
  );
}
