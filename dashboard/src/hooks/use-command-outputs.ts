/**
 * Per-session, client-local command output items.
 *
 * Contract: these are never persisted. They live in memory for the lifetime
 * of the page, keyed by session id, and are lost on reload. Each item records
 * `afterCount`, the number of transcript items that were visible when the
 * command ran, so the transcript can render it at that position rather than
 * pinning every output to the bottom.
 */

import { useCallback, useState } from 'react';
import type { CommandResponse } from '@/types/command-wire';

export interface CommandOutputItem {
  /** Stable insertion key, monotonically increasing across all sessions. */
  key: number;
  input: string;
  response: CommandResponse;
  /** Transcript length at the moment the output arrived. */
  afterCount: number;
}

export interface UseCommandOutputsResult {
  /** Ordered output items for one session (empty when none). */
  itemsFor: (sessionId: string | null) => CommandOutputItem[];
  /** Append an output for a session, anchored after `afterCount` transcript items. */
  addItem: (sessionId: string, input: string, response: CommandResponse, afterCount: number) => void;
}

const EMPTY: CommandOutputItem[] = [];
let nextKey = 0;

export function useCommandOutputs(): UseCommandOutputsResult {
  const [bySession, setBySession] = useState<Record<string, CommandOutputItem[]>>({});

  const addItem = useCallback(
    (sessionId: string, input: string, response: CommandResponse, afterCount: number) => {
      const item: CommandOutputItem = { key: ++nextKey, input, response, afterCount };
      setBySession((prev) => ({ ...prev, [sessionId]: [...(prev[sessionId] ?? EMPTY), item] }));
    },
    [],
  );

  const itemsFor = useCallback(
    (sessionId: string | null) => (sessionId === null ? EMPTY : bySession[sessionId] ?? EMPTY),
    [bySession],
  );

  return { itemsFor, addItem };
}
