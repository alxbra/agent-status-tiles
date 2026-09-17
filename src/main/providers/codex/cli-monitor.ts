import { qualifyCodexCliCatalog } from './cli-qualification';
import { CodexSurfaceMonitor, type CodexMonitorOptions } from './desktop-monitor';
import { resolvePathCodexBinary, type CodexPathBinaryResolutionCode } from './path-binary-resolver';

/** Resolver outcomes that mean no `codex` executable is installed on PATH. */
const CLI_MISSING_INSTALLATION_CODES: ReadonlySet<CodexPathBinaryResolutionCode> = new Set([
  'path-unavailable',
  'binary-missing',
]);

export type CodexCliMonitorOptions = CodexMonitorOptions;

/** Codex CLI has its own catalog process, baseline, cursors, and retained observations. */
export class CodexCliMonitor extends CodexSurfaceMonitor {
  constructor(options: CodexCliMonitorOptions = {}) {
    super(
      options,
      'cli',
      qualifyCodexCliCatalog,
      resolvePathCodexBinary,
      CLI_MISSING_INSTALLATION_CODES,
    );
  }
}
