/**
 * Pluggable tool dispatcher for the `anthropic-direct` provider.
 *
 * Re-exports `ToolDispatcher` from `./types.ts` (the single definition) and
 * provides a default `RejectAllToolDispatcher` that returns an
 * `isError: true` result for every call. The default dispatcher is what
 * makes v1 ship safely without real tool implementations — the model sees
 * an honest error and can recover or end-turn.
 *
 * @module agent/providers/anthropic-direct/tool-dispatcher
 */

import type { ToolCall, ToolResult, ToolDispatcher } from './types.js';

/**
 * Default dispatcher used when no real tool implementations are wired in.
 * Returns `{ isError: true, content: <message> }` for every call so the
 * model can either recover gracefully or end the turn — preferable to a
 * silent failure or a thrown error that aborts the whole session.
 *
 * Implemented as a real class (not a const) so consumers can
 * `extends RejectAllToolDispatcher` and override only specific tools.
 */
export class RejectAllToolDispatcher implements ToolDispatcher {
  async execute(call: ToolCall): Promise<ToolResult> {
    return {
      isError: true,
      content: `Tool "${call.name}" is not implemented in the anthropic-direct provider (v1). Wire a real ToolDispatcher to enable tool execution.`,
    };
  }
}

export type { ToolDispatcher, ToolCall, ToolResult } from './types.js';
