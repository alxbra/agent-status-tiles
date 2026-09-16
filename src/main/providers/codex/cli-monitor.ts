import { qualifyCodexCliCatalog } from './cli-qualification';
import { CodexSurfaceMonitor, type CodexMonitorOptions } from './desktop-monitor';
import { resolvePathCodexBinary } from './path-binary-resolver';

export type CodexCliMonitorOptions = CodexMonitorOptions;

/** Codex CLI has its own catalog process, baseline, cursors, and retained observations. */
export class CodexCliMonitor extends CodexSurfaceMonitor {
  constructor(options: CodexCliMonitorOptions = {}) {
    super(options, 'cli', qualifyCodexCliCatalog, resolvePathCodexBinary);
  }
}
