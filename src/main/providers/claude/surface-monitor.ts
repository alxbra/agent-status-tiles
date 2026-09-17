import { makeCursorKey, type FileCursorMap } from '../../../shared/cursor';
import type { Surface } from '../../../shared/session';
import { MAX_RECENT_THREAD_LIMIT } from '../../../shared/settings';
import {
  MAX_RUNTIME_EVENTS_PER_READ,
  type ProviderSurfaceMonitor,
  type RuntimeDiscoveryResult,
  type RuntimeMonitorSource,
  type RuntimeReadRequest,
  type RuntimeReadResult,
} from '../../runtime/coordinator';
import {
  HookJournalReader,
  type HookJournalDiagnosticCode,
  type HookJournalReadResult,
  type HookJournalTarget,
} from '../hooks/hook-journal-reader';
import { MAX_INPUT_REQUESTS } from '../../sessions/persistence';
import { normalizeClaudeEvents } from './events';
import type { ClaudeIssue, ClaudeReadiness } from './readiness';
import type { ClaudeJournalCollector } from './journal-collector';
import {
  ClaudeJournalDiscovery,
  selectCohort,
  type ClaudeJournalSummary,
} from './journal-discovery';

export interface ClaudeMonitorOptions {
  /** The app's private data directory; journals live under `journals/claude`. */
  appDataPath: string;
  /**
   * Verify the helper and the hooks before observing. Absent in tests that
   * seed journals directly; production wires the installer's inspection.
   */
  checkReadiness?: () => Promise<ClaudeReadiness>;
  /**
   * Garbage collection of ended journals, shared by both surfaces and asked
   * to sweep after every discovery; it throttles itself and never fails a pass.
   */
  collector?: Pick<ClaudeJournalCollector, 'sweep'>;
  /** Test injection. */
  reader?: Pick<HookJournalReader, 'read'>;
  discovery?: Pick<ClaudeJournalDiscovery, 'list' | 'truncated'>;
}

/** A journal that could not be read safely; its session shows as unavailable. */
const SOURCE_UNAVAILABLE_DIAGNOSTICS: ReadonlySet<HookJournalDiagnosticCode> = new Set([
  'unsafe-source',
  'source-not-regular',
  'source-oversized',
  'source-read-failed',
  'source-truncated',
  'source-unstable',
]);
/** History was skipped but the remaining observations stay usable. */
const COVERAGE_DIAGNOSTICS: ReadonlySet<HookJournalDiagnosticCode> = new Set([
  'record-malformed',
  'record-oversized',
  'possible-retention-gap',
  'cursor-truncated',
]);
/**
 * A record can expand into two lifecycle events (a resolution plus a
 * progress or completion event), and seeding a read can resolve every open
 * request of every target; the normalizer issues at most
 * `MAX_INPUT_REQUESTS` requests per turn, so the reader page is sized to keep
 * one read's events under the coordinator's cap in the worst case.
 */
export const MAX_CLAUDE_RECORDS_PER_READ = Math.floor(
  (MAX_RUNTIME_EVENTS_PER_READ - MAX_INPUT_REQUESTS * MAX_RECENT_THREAD_LIMIT) / 2,
);

function readerCursorKey(baseName: string): string {
  return makeCursorKey('claude', baseName);
}

function runtimeSourceId(cursorKey: string): string {
  if (!cursorKey.startsWith('claude:')) throw new Error('invalid-claude-cursor-key');
  return cursorKey.slice('claude:'.length);
}

/**
 * One Claude surface. Discovery lists the app's own journal directory and
 * keeps the newest journals whose latest record came from this surface;
 * reads replay those journals through the bounded hook-journal reader and
 * normalize them into lifecycle events. No path leaves this class.
 */
export class ClaudeSurfaceMonitor implements ProviderSurfaceMonitor {
  readonly key: 'claude:desktop' | 'claude:cli';
  private readonly surface: Surface;
  private readonly reader: Pick<HookJournalReader, 'read'>;
  private readonly discovery: Pick<ClaudeJournalDiscovery, 'list' | 'truncated'>;
  private readonly collector: Pick<ClaudeJournalCollector, 'sweep'> | undefined;
  private readonly checkReadiness: (() => Promise<ClaudeReadiness>) | undefined;
  private issue: ClaudeIssue | undefined;
  private journals = new Map<string, ClaudeJournalSummary>();
  private unavailableSourceIds = new Set<string>();
  private started = false;

  constructor(options: ClaudeMonitorOptions, surface: Surface) {
    this.surface = surface;
    this.key = `claude:${surface}`;
    this.reader = options.reader ?? new HookJournalReader({ appDataPath: options.appDataPath });
    this.discovery =
      options.discovery ?? new ClaudeJournalDiscovery({ appDataPath: options.appDataPath });
    this.collector = options.collector;
    this.checkReadiness = options.checkReadiness;
  }

  /** Base names of the journals in this surface's current cohort; the collector keeps them. */
  get cohort(): ReadonlySet<string> {
    return new Set(this.journals.keys());
  }

  /** The reason the last start failed, for the Settings sentence; undefined once healthy. */
  get lastIssue(): ClaudeIssue | undefined {
    return this.issue;
  }

  async start(): Promise<void> {
    if (this.checkReadiness !== undefined) {
      const readiness = await this.checkReadiness();
      if (readiness.status === 'issue') {
        this.issue = readiness.issue;
        throw new Error(`claude-${this.surface}-${readiness.issue}`);
      }
    }
    this.issue = undefined;
    this.started = true;
  }

  stop(): void {
    this.started = false;
    this.issue = undefined;
    this.journals.clear();
    this.unavailableSourceIds.clear();
  }

  async discover(): Promise<RuntimeDiscoveryResult> {
    if (!this.started) throw new Error(`claude-${this.surface}-not-started`);
    const cohort = selectCohort(await this.discovery.list(), this.surface);
    const journals = new Map<string, ClaudeJournalSummary>();
    const sources: RuntimeMonitorSource[] = [];
    for (const journal of cohort) {
      journals.set(journal.baseName, journal);
      sources.push({
        id: journal.baseName,
        nativeSessionId: journal.nativeSessionId,
        // The project folder name is the plan's title; a short session ID
        // stands in when no project was recorded. Never prompt content.
        title: journal.projectName ?? journal.nativeSessionId.slice(0, 8),
        updatedAt: journal.updatedAt,
        isTopLevel: true,
        isArchived: false,
        canOpen: false,
      });
    }
    this.journals = journals;
    this.unavailableSourceIds.clear();
    // The collector reads the cohort just set; a sweep never fails discovery.
    await this.collector?.sweep().catch(() => undefined);
    return {
      complete: true,
      capturedAt: Date.now(),
      sources,
      // More journals than the listing can stat means the newest may be missing.
      ...(this.discovery.truncated ? { coverageIncomplete: true } : {}),
    };
  }

  capture(sources: readonly RuntimeMonitorSource[]): readonly RuntimeMonitorSource[] {
    return sources.map((source) => {
      const journal = this.journals.get(source.id);
      if (journal === undefined || journal.nativeSessionId !== source.nativeSessionId) {
        throw new Error(`claude-${this.surface}-source-changed`);
      }
      return { ...source, endOffset: journal.endOffset };
    });
  }

  async read(request: RuntimeReadRequest): Promise<RuntimeReadResult> {
    const active: RuntimeMonitorSource[] = [];
    const metadataOnlySourceIds: string[] = [];
    for (const source of request.sources) {
      const journal = this.journals.get(source.id);
      if (journal === undefined || journal.nativeSessionId !== source.nativeSessionId) {
        throw new Error(`claude-${this.surface}-source-changed`);
      }
      if (active.length < MAX_RECENT_THREAD_LIMIT) active.push(source);
      else metadataOnlySourceIds.push(source.id);
    }
    const targets: HookJournalTarget[] = active.map((source) => ({
      provider: 'claude',
      nativeSessionId: source.nativeSessionId,
      baseName: source.id,
    }));
    const activeIds = new Set(active.map((source) => source.id));
    const readerCursors: FileCursorMap = Object.fromEntries(
      Object.entries(request.cursors)
        .filter(([sourceId]) => activeIds.has(sourceId))
        .map(([sourceId, cursor]) => [readerCursorKey(sourceId), cursor]),
    );
    const result: HookJournalReadResult = await this.reader.read(targets, readerCursors, {
      startTargetIndex: Math.min(request.sourceStart ?? 0, targets.length),
      maxRecords: MAX_CLAUDE_RECORDS_PER_READ,
    });
    let coverageIncomplete = false;
    for (const diagnostic of result.diagnostics) {
      // Reader diagnostics name the journal by its base name, our source ID.
      if (SOURCE_UNAVAILABLE_DIAGNOSTICS.has(diagnostic.code)) {
        this.unavailableSourceIds.add(diagnostic.sourceId);
      } else if (COVERAGE_DIAGNOSTICS.has(diagnostic.code)) {
        coverageIncomplete = true;
      }
      // `read-limit` is an ordinary budget stop followed by a continuation.
    }
    // A baseline exists only to land history idle and place the cursor, so
    // it keeps the turn events that decide a session's final state and drops
    // per-tool progress and waits; this keeps a first replay of full journals
    // far under the coordinator's per-replay event bound. A wait that is
    // already open at connect time shows as working until its next record.
    const sessionEvents = normalizeClaudeEvents(result.events, request.sessions).filter(
      (event) =>
        !request.baseline ||
        event.type === 'turn-started' ||
        event.type === 'turn-completed' ||
        event.type === 'turn-failed',
    );
    const readIds = active.map((source) => source.id);
    const finished = result.nextTargetIndex === undefined;
    return {
      events: sessionEvents.map((event) => ({ event, historical: request.baseline })),
      cursors: Object.fromEntries(
        Object.entries(result.cursors).map(([key, cursor]) => [runtimeSourceId(key), cursor]),
      ),
      // Without a continuation the reader has consumed every complete record
      // of every readable target; unreadable ones are reported unavailable.
      complete: finished,
      ...(coverageIncomplete ? { coverageIncomplete: true } : {}),
      ...(this.unavailableSourceIds.size > 0 || metadataOnlySourceIds.length > 0
        ? {
            unavailableSourceIds: [
              ...new Set([...this.unavailableSourceIds, ...metadataOnlySourceIds]),
            ],
          }
        : {}),
      ...(finished ? {} : { nextSourceIndex: result.nextTargetIndex }),
      exhaustedSourceIds: [...(finished ? readIds : []), ...metadataOnlySourceIds],
    };
  }
}

/** Claude sessions hosted by the Claude Desktop app. */
export class ClaudeDesktopMonitor extends ClaudeSurfaceMonitor {
  constructor(options: ClaudeMonitorOptions) {
    super(options, 'desktop');
  }
}

/** Claude sessions started from a terminal (or from an unrecognised host). */
export class ClaudeCliMonitor extends ClaudeSurfaceMonitor {
  constructor(options: ClaudeMonitorOptions) {
    super(options, 'cli');
  }
}
