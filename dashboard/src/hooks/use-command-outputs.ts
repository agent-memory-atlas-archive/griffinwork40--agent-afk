/**
 * Per-session client-local command output items.
 *
 * These are never persisted — they live only in memory for the duration of
 * the browser session and are cleared on reload (A7 contract).
 */

import { useCallback, useState } from 'react';
import type { CommandResponse } from '@/types/command-wire';

export interface CommandOutputItem {
  /** Stable insertion key — monotonically increasing across all sessions. */
  key: number;
  input: string;
  response: CommandResponse;
}

let _nextKey = 0;

export interface UseCommandOutputsResult {
  /** Ordered list of output items for the active session. */
  items: CommandOutputItem[];
  /** Append a new item (called from composer on success). */
  addItem: (input: string, response: CommandResponse) => void;
  /** Clear all items for the current session (called on session switch). */
  clear: () => void;
}

export function useCommandOutputs(): UseCommandOutputsResult {
  const [items, setItems] = useState<CommandOutputItem[]>([]);

  const addItem = useCallback((input: string, response: CommandResponse) => {
    const key = ++_nextKey;
    setItems((prev) => [...prev, { key, input, response }]);
  }, []);

  const clear = useCallback(() => {
    setItems([]);
  }, []);

  return { items, addItem, clear };
}
