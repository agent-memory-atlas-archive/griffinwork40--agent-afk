/**
 * Unit tests for `repairOrphanToolUses` — the self-healing guard that runs
 * before every new user-turn append in `query.ts`.
 *
 * The Anthropic Messages API rejects any request whose history contains an
 * assistant `tool_use` block not immediately followed by a user `tool_result`
 * block covering its id:
 *
 *   400 messages.N: `tool_use` ids were found without `tool_result` blocks
 *   immediately after: toolu_XXX
 *
 * Causes encountered in the wild:
 *   1. User typed mid-stream → interrupt raced past loop.ts's rollback gate.
 *   2. A persisted session JSON written by an older AFK build (before the
 *      rollback existed) is loaded via `initialMessages` and the orphan rides
 *      through to the first request.
 *   3. A resumed session whose persisted history contains a mid-history
 *      interrupt (non-tail orphan) — #2007.
 *
 * This helper is the second layer of defense — loop.ts's rollback is the
 * primary defense for live turns; this guard recovers anything that made it
 * past the rollback or arrived from disk.
 */

import { describe, it, expect } from 'vitest';
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import { repairOrphanToolUses } from './query/repair-orphan-tool-uses.js';

describe('repairOrphanToolUses', () => {
  it('is a no-op on empty history', () => {
    const messages: MessageParam[] = [];
    repairOrphanToolUses(messages);
    expect(messages).toEqual([]);
  });

  it('is a no-op when the last message is a user message', () => {
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    repairOrphanToolUses(messages);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.role).toBe('user');
  });

  it('is a no-op when the last assistant message has only text blocks', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello back' }] as ContentBlockParam[],
      },
    ];
    repairOrphanToolUses(messages);
    expect(messages).toHaveLength(2);
  });

  it('is a no-op when the assistant content is a plain string', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'plain string response' },
    ];
    repairOrphanToolUses(messages);
    expect(messages).toHaveLength(2);
  });

  it('inserts a synthetic tool_result repair when the last assistant message has an unmatched tool_use', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'do a thing' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'sure, calling tool' },
          {
            type: 'tool_use',
            id: 'toolu_orphan',
            name: 'read_file',
            input: { file: 'a.ts' },
          },
        ] as ContentBlockParam[],
      },
    ];

    repairOrphanToolUses(messages);

    expect(messages).toHaveLength(3);
    const repair = messages[2]!;
    expect(repair.role).toBe('user');
    expect(typeof repair.content).not.toBe('string');
    const repairBlocks = repair.content as ContentBlockParam[];
    expect(repairBlocks).toHaveLength(1);
    const tr = repairBlocks[0] as {
      type: string;
      tool_use_id: string;
      is_error: boolean;
      content: string;
    };
    expect(tr.type).toBe('tool_result');
    expect(tr.tool_use_id).toBe('toolu_orphan');
    expect(tr.is_error).toBe(true);
    expect(typeof tr.content).toBe('string');
    expect(tr.content.length).toBeGreaterThan(0);
  });

  it('covers every orphan tool_use in a single repair message when multiple are present', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'do many things' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_a',
            name: 'read_file',
            input: { file: 'a.ts' },
          },
          {
            type: 'tool_use',
            id: 'toolu_b',
            name: 'read_file',
            input: { file: 'b.ts' },
          },
        ] as ContentBlockParam[],
      },
    ];

    repairOrphanToolUses(messages);

    expect(messages).toHaveLength(3);
    const repair = messages[2]!;
    const blocks = repair.content as ContentBlockParam[];
    const ids = blocks
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b as { tool_use_id: string }).tool_use_id);
    expect(ids).toEqual(['toolu_a', 'toolu_b']);
  });

  it('does NOT double-repair: a second invocation after repair is a no-op', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_x',
            name: 'read_file',
            input: {},
          },
        ] as ContentBlockParam[],
      },
    ];
    repairOrphanToolUses(messages);
    expect(messages).toHaveLength(3);
    repairOrphanToolUses(messages);
    // The second call should observe that the tail is now a user message
    // (the repair we just inserted) and do nothing.
    expect(messages).toHaveLength(3);
  });

  // ─── Non-tail orphan tests (#2007) ───────────────────────────────────────

  it('repairs a non-tail orphan: mid-history assistant tool_use with no following tool_result', () => {
    // Simulates a resumed session where a mid-history interrupt left an orphan
    // followed by later conversation that continued as if it never happened.
    const messages: MessageParam[] = [
      { role: 'user', content: 'first prompt' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_mid',
            name: 'bash',
            input: { command: 'ls' },
          },
        ] as ContentBlockParam[],
      },
      // Next user message is NOT a tool_result — simulates the interrupted state
      { role: 'user', content: 'second prompt after resume' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'continuing...' }] as ContentBlockParam[],
      },
    ];

    repairOrphanToolUses(messages);

    // A repair message should be inserted at index 2, between the orphan
    // assistant message (index 1) and the following user prompt (now index 3).
    expect(messages).toHaveLength(5);
    const repair = messages[2]!;
    expect(repair.role).toBe('user');
    const repairBlocks = repair.content as ContentBlockParam[];
    expect(repairBlocks).toHaveLength(1);
    const tr = repairBlocks[0] as {
      type: string;
      tool_use_id: string;
      is_error: boolean;
    };
    expect(tr.type).toBe('tool_result');
    expect(tr.tool_use_id).toBe('toolu_mid');
    expect(tr.is_error).toBe(true);

    // The rest of the history should be preserved in order.
    expect(messages[3]?.role).toBe('user');
    expect(messages[3]?.content).toBe('second prompt after resume');
    expect(messages[4]?.role).toBe('assistant');
  });

  it('repairs multiple non-tail orphans independently', () => {
    // Two separate mid-history orphans — each should get its own repair message.
    const messages: MessageParam[] = [
      { role: 'user', content: 'turn 1' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_first',
            name: 'bash',
            input: { command: 'echo a' },
          },
        ] as ContentBlockParam[],
      },
      // No tool_result — first orphan
      { role: 'user', content: 'turn 2' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_second',
            name: 'bash',
            input: { command: 'echo b' },
          },
        ] as ContentBlockParam[],
      },
      // No tool_result — second orphan
      { role: 'user', content: 'turn 3' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }] as ContentBlockParam[],
      },
    ];

    repairOrphanToolUses(messages);

    // 6 original + 2 repair messages = 8
    expect(messages).toHaveLength(8);

    // After repair, all assistant tool_use messages should be followed by
    // a user message whose first block is a tool_result.
    for (let i = 0; i < messages.length - 1; i++) {
      const msg = messages[i]!;
      if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
      const hasToolUse = (msg.content as ContentBlockParam[]).some(
        (b) => b.type === 'tool_use',
      );
      if (!hasToolUse) continue;
      const next = messages[i + 1]!;
      expect(next.role).toBe('user');
      const nextBlocks = next.content as ContentBlockParam[];
      expect(nextBlocks.some((b) => b.type === 'tool_result')).toBe(true);
    }
  });

  it('does not insert repair when a non-tail assistant tool_use is already followed by tool_result', () => {
    // A healthy mid-history pair: assistant tool_use followed by user tool_result.
    const messages: MessageParam[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_covered',
            name: 'bash',
            input: { command: 'ls' },
          },
        ] as ContentBlockParam[],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_covered',
            content: 'file.txt',
          },
        ] as ContentBlockParam[],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }] as ContentBlockParam[],
      },
    ];

    repairOrphanToolUses(messages);

    // No repair should be inserted — history is already healthy.
    expect(messages).toHaveLength(4);
  });

  it('repairs only the partially-covered tool_use IDs when a following user message covers some but not all', () => {
    // Assistant emits two tool_use blocks; the following user message only
    // supplies a tool_result for one of them.
    const messages: MessageParam[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_covered',
            name: 'bash',
            input: { command: 'echo covered' },
          },
          {
            type: 'tool_use',
            id: 'toolu_orphan',
            name: 'bash',
            input: { command: 'echo orphan' },
          },
        ] as ContentBlockParam[],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_covered',
            content: 'ok',
          },
        ] as ContentBlockParam[],
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }] as ContentBlockParam[],
      },
    ];

    repairOrphanToolUses(messages);

    // A repair for toolu_orphan should be inserted at index 2
    // (between the assistant at index 1 and the existing user at index 2).
    expect(messages).toHaveLength(5);
    const repair = messages[2]!;
    expect(repair.role).toBe('user');
    const repairBlocks = repair.content as ContentBlockParam[];
    expect(repairBlocks).toHaveLength(1);
    const tr = repairBlocks[0] as { type: string; tool_use_id: string; is_error: boolean };
    expect(tr.type).toBe('tool_result');
    expect(tr.tool_use_id).toBe('toolu_orphan');
    expect(tr.is_error).toBe(true);
  });

  it('does NOT double-repair a non-tail orphan on a second invocation', () => {
    const messages: MessageParam[] = [
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_mid',
            name: 'bash',
            input: {},
          },
        ] as ContentBlockParam[],
      },
      { role: 'user', content: 'second' },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }] as ContentBlockParam[],
      },
    ];

    repairOrphanToolUses(messages);
    const lengthAfterFirst = messages.length;
    repairOrphanToolUses(messages);
    // Second call must not insert any additional repair.
    expect(messages).toHaveLength(lengthAfterFirst);
  });
});
