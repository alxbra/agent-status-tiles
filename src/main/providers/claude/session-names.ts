import { open, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';

import { MAX_TITLE_BYTES } from '../../../shared/session';
import { isSafeString } from '../hooks/hook-journal-reader';
import { defaultClaudeConfigDirectory } from './hook-installer';

/** Registry files considered per lookup; each is a small JSON document. */
const MAX_REGISTRY_FILES = 256;
const MAX_REGISTRY_BYTES = 64 * 1024;
const REGISTRY_FILE = /^\d+\.json$/u;

interface CacheEntry {
  mtimeMs: number;
  size: number;
  sessionId: string | undefined;
  name: string | undefined;
}

/**
 * Claude Code keeps one small JSON file per running process under its
 * configuration directory's `sessions` folder, carrying the session ID and
 * the name the Desktop sidebar shows. This is observed rather than documented
 * behaviour, so it is read as best-effort display enrichment only: bounded,
 * validated, and never required. Only the session ID and name are retained;
 * every other field, including the working directory, is ignored.
 */
export class ClaudeSessionNames {
  private readonly directory: string;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(options: { configDirectory?: string } = {}) {
    this.directory = join(options.configDirectory ?? defaultClaudeConfigDirectory(), 'sessions');
  }

  /** Session ID to Claude's own session name, for every readable registry file. */
  async lookup(): Promise<ReadonlyMap<string, string>> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch {
      return new Map();
    }
    const live = new Set<string>();
    const result = new Map<string, string>();
    for (const name of names
      .filter((entry) => REGISTRY_FILE.test(entry))
      .slice(0, MAX_REGISTRY_FILES)) {
      live.add(name);
      const entry = await this.read(name);
      if (entry?.sessionId !== undefined && entry.name !== undefined) {
        result.set(entry.sessionId, entry.name);
      }
    }
    for (const name of this.cache.keys()) if (!live.has(name)) this.cache.delete(name);
    return result;
  }

  private async read(name: string): Promise<CacheEntry | undefined> {
    let handle;
    try {
      handle = await open(
        join(this.directory, name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch {
      return undefined;
    }
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size > MAX_REGISTRY_BYTES) return undefined;
      const cached = this.cache.get(name);
      if (
        cached !== undefined &&
        cached.mtimeMs === metadata.mtimeMs &&
        cached.size === metadata.size
      ) {
        return cached;
      }
      const buffer = Buffer.alloc(metadata.size);
      const { bytesRead } = await handle.read(buffer, 0, metadata.size, 0);
      let parsed: unknown;
      try {
        parsed = JSON.parse(buffer.toString('utf8', 0, bytesRead));
      } catch {
        parsed = undefined;
      }
      const record =
        parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      const entry: CacheEntry = {
        mtimeMs: metadata.mtimeMs,
        size: metadata.size,
        sessionId: isSafeString(record.sessionId, 256) ? record.sessionId : undefined,
        name: isSafeString(record.name, MAX_TITLE_BYTES) ? record.name : undefined,
      };
      this.cache.set(name, entry);
      return entry;
    } catch {
      return undefined;
    } finally {
      await handle.close();
    }
  }
}
