/**
 * The originators Codex Desktop writes into its threads' metadata. Builds from
 * 2026-09-24 on (the Codex framework inside ChatGPT.app, CLI 0.155.0-alpha.16.3)
 * write `codex_work_desktop`; earlier builds and older threads keep
 * `Codex Desktop`. Any other value is not Desktop evidence.
 */
const CODEX_DESKTOP_ORIGINATORS: ReadonlySet<string> = new Set([
  'Codex Desktop',
  'codex_work_desktop',
]);

export function isCodexDesktopOriginator(value: unknown): boolean {
  return typeof value === 'string' && CODEX_DESKTOP_ORIGINATORS.has(value);
}
