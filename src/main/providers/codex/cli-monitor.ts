import { qualifyCodexCliCatalog } from './cli-qualification';
import {
  CLI_MISSING_INSTALLATION_CODES,
  CodexSurfaceMonitor,
  type CodexMonitorOptions,
} from './desktop-monitor';
import { resolvePathCodexBinary } from './path-binary-resolver';

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
