import type { Provider } from './session';

export interface FileCursor {
  identity: string;
  offset: number;
  baselineUntilOffset?: number;
  isDiscardingOversizedLine?: boolean;
}

export type FileCursorMap = Readonly<Record<string, FileCursor>>;

/** Cursor keys are provider-scoped relative source IDs, never absolute paths. */
export function makeCursorKey(provider: Provider, relativeSourceId: string): string {
  return `${provider}:${relativeSourceId}`;
}
