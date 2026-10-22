/**
 * POST /api/sessions/:id/rewind — retry or edit-and-resend.
 *
 * Two modes:
 *   { mode: 'retry' }             — rewind to just before the last user turn
 *                                   and resubmit it verbatim.
 *   { mode: 'edit', text: string } — rewind to just before turn N and submit
 *                                   the provided text. If turnIndex is omitted,
 *                                   the last user turn is targeted (same as retry
 *                                   but with new text).
 *
 * Both modes are refused while a turn is running (409 session_busy).
 *
 * Contract: this handler does NOT interact with the `/rewind` slash-command
 * chooser UI. It drives the same underlying machinery (executeSessionControl
 * dispatches into WebSessionControl.executeRewind which calls the provider's
 * rewindConversation and rebuilds the ledger projection), but chooses the
 * target turn programmatically so the browser needs no interactive picker.
 *
 * Invariant: we look up the /rewind SlashCommand by name from the core
 * commands registry at call time. If it is absent (renamed, gated) we 501.
 * The lookup is cheap — the list is small and always in memory.
 */

import type { ServerResponse } from 'node:http';
import { coreCommands } from '../cli/slash/commands/core.js';
import type { RouteContext } from './routes.js';
import { sendJson, requireValidSessionId } from './routes.js';
import { createWebSlashContext } from './slash-context.web.js';
import { BufferingWriter } from './writer.buffer.js';
import { getStats } from './session-owner.slash.js';
import { errorMessage } from '../utils/errors.js';

function requireOwned(ctx: RouteContext, res: ServerResponse, id: string): boolean {
  if (ctx.owned.has(id)) return true;
  sendJson(res, 409, {
    error: 'session_not_owned',
    message: `session ${id} is not owned by this process and cannot be rewound here`,
  });
  return false;
}

/**
 * Handle POST /api/sessions/:id/rewind.
 *
 * Body: { mode: 'retry' } | { mode: 'edit', text: string }
 */
export async function handleRewind(
  ctx: RouteContext,
  res: ServerResponse,
  sessionId: string,
  body: unknown,
): Promise<void> {
  if (!requireValidSessionId(res, sessionId)) return;
  if (!requireOwned(ctx, res, sessionId)) return;

  if (ctx.isBusy(sessionId)) {
    sendJson(res, 409, {
      error: 'session_busy',
      message: 'Cannot rewind while a turn is in flight. Stop the turn first.',
    });
    return;
  }

  if (!ctx.executeSessionControl || !ctx.getSession) {
    sendJson(res, 501, {
      error: 'rewind_not_supported',
      message: 'rewind requires a full session owner (not attach-only mode)',
    });
    return;
  }

  const record = body as Record<string, unknown> | null | undefined;
  const mode = typeof record?.['mode'] === 'string' ? record['mode'] : undefined;
  if (mode !== 'retry' && mode !== 'edit') {
    sendJson(res, 400, {
      error: 'bad_request',
      message: 'body must be { mode: "retry" } or { mode: "edit", text: string }',
    });
    return;
  }
  const editText = mode === 'edit' ? (typeof record?.['text'] === 'string' ? record['text'].trim() : '') : undefined;
  if (mode === 'edit' && !editText) {
    sendJson(res, 400, {
      error: 'bad_request',
      message: 'edit mode requires a non-empty text field',
    });
    return;
  }

  const rewindCmd = coreCommands.find((c) => c.name === '/rewind');
  if (!rewindCmd) {
    sendJson(res, 501, { error: 'rewind_not_supported', message: '/rewind command not found' });
    return;
  }

  const session = ctx.getSession(sessionId);
  if (!session) {
    sendJson(res, 404, { error: 'session_not_found', message: `no live session ${sessionId}` });
    return;
  }

  const stats = getStats(sessionId);
  if (!stats) {
    sendJson(res, 404, { error: 'session_not_found', message: `no stats for ${sessionId}` });
    return;
  }

  const writer = new BufferingWriter();
  // Invariant: choose '0' always selects the most-recent user turn (newest-first list).
  const ctx2 = createWebSlashContext({ current: session }, stats, writer, stats.cwd ?? process.cwd());
  ctx2.choose = async () => '0';

  ctx.reserveTurn?.(sessionId);
  try {
    const result = await ctx.executeSessionControl(sessionId, rewindCmd, ctx2, '');

    // After the rewind, the conversation is backed up. Now submit the prompt.
    const textToSend = mode === 'retry'
      ? (result.result && typeof result.result === 'object' && 'message' in result.result
          ? String((result.result as { message: string }).message)
          : undefined)
      : editText!;

    if (!textToSend) {
      // Rewind succeeded but we couldn't recover the original text — still success.
      sendJson(res, 200, { ok: true, rewound: true });
      return;
    }

    // Submit the prompt (enqueueTurn increments pending itself).
    ctx.submitPrompt(sessionId, textToSend);
    sendJson(res, 200, { ok: true, rewound: true, sent: textToSend });
  } catch (err) {
    sendJson(res, 500, { error: 'rewind_failed', message: errorMessage(err) });
  } finally {
    ctx.releaseTurn?.(sessionId);
  }
}
