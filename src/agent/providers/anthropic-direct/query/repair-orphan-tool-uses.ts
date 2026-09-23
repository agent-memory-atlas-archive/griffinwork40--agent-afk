/**
 * Self-healing guard: scan `messages` for any assistant message whose
 * `content` carries `tool_use` blocks not immediately followed by a user
 * `tool_result` covering each id. When found, insert a synthetic user
 * message of `is_error: true` `tool_result` placeholders so the next
 * Messages API call satisfies Anthropic's contract: "Each `tool_use`
 * block must have a corresponding `tool_result` block in the next message."
 *
 * Mutates `messages` in place by splicing repair messages after each
 * offending assistant turn. The full history is scanned — not just the tail
 * — so that orphans from mid-history interrupts in persisted sessions are
 * also recovered. Paths that reach this function with broken history include:
 *   1. A session restored from a persisted history where a mid-turn interrupt
 *      left a non-tail orphan (the primary motivation for the full-scan).
 *   2. A session restored from a corrupted on-disk persist (older builds
 *      that lacked the rollback could leak orphans at the tail).
 *   3. A defensive fallback if some future codepath bypasses the loop's
 *      rollback.
 *
 * Scanning is done from the end of the array toward the front so that
 * splice insertions do not shift the indices of messages yet to be visited.
 *
 * Extracted from `query.ts` to keep the orchestrator focused. Sibling
 * unit tests live at `../repair-orphan-tool-uses.test.ts`.
 *
 * @module agent/providers/anthropic-direct/query/repair-orphan-tool-uses
 */

import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';

/**
 * Collect all `tool_result` IDs from a user message's content, or return an
 * empty set when the message is not a user message or has string content.
 */
function coveredToolResultIds(msg: MessageParam | undefined): Set<string> {
  if (!msg || msg.role !== 'user' || typeof msg.content === 'string') {
    return new Set();
  }
  const covered = new Set<string>();
  for (const b of msg.content as ContentBlockParam[]) {
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      covered.add(b.tool_use_id);
    }
  }
  return covered;
}

export function repairOrphanToolUses(messages: MessageParam[]): void {
  if (messages.length === 0) return;

  // Iterate from the end toward the front so that splice() insertions do not
  // invalidate the indices of messages still to be visited.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant' || typeof msg.content === 'string') {
      continue;
    }

    const blocks = msg.content as ContentBlockParam[];
    const toolUseIds: string[] = [];
    for (const b of blocks) {
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        toolUseIds.push(b.id);
      }
    }
    if (toolUseIds.length === 0) continue;

    // Check which tool_use IDs are already covered by the immediately
    // following message's tool_result blocks.
    const covered = coveredToolResultIds(messages[i + 1]);
    const orphanIds = toolUseIds.filter((id) => !covered.has(id));
    if (orphanIds.length === 0) continue;

    const repair: MessageParam = {
      role: 'user',
      content: orphanIds.map((id) => ({
        type: 'tool_result' as const,
        tool_use_id: id,
        content: 'Tool call interrupted before completing — no result recorded.',
        is_error: true,
      })) as ContentBlockParam[],
    };
    // Insert the repair message immediately after the offending assistant turn.
    messages.splice(i + 1, 0, repair);
  }
}
