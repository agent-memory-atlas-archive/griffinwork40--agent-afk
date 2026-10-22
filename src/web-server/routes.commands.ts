/**
 * POST /api/sessions/:id/commands — execute a native slash command on a
 * web-owned session and return the buffered output as JSON.
 *
 * Ordering (Amendment A2):
 *   1. Validate session id
 *   2. Require owned
 *   3. Require turn-accounting present (501 if absent — no isBusy/reserveTurn)
 *   4. Parse body
 *   5. isBusy → 409  (no await between this check and reserveTurn)
 *   6. reserveTurn (synchronous)
 *   7. try { registry + gate + ctx + handler } finally { releaseTurn }
 */

import type { ServerResponse } from 'node:http';
import { sendJson, requireValidSessionId } from './routes.js';
import type { RouteContext } from './routes.js';
import type { AgentSession } from '../agent/session/agent-session.js';
import { ensureSlashRegistry } from './slash-registry.js';
import { parse, lookup, suggest } from '../cli/slash/registry.js';
import { isGated, gateReason } from './command-gate.js';
import { BufferingWriter } from './writer.buffer.js';
import { getStats, buildSessionRef, buildOptionalSessionRef } from './session-owner.slash.js';
import { createWebSlashContext } from './slash-context.web.js';
import { normalizeSlashResult } from './slash-result.web.js';
export { normalizeSlashResult } from './slash-result.web.js';

/**
 * Poll owner.getSession up to 2s (40 × 50ms) before giving up.
 * The poll exists because a session may be created and stored in the owner
 * a few milliseconds after the route receives the request (creation is async).
 * Tests that want immediate failure should mock getSession to return undefined
 * and use vi.useFakeTimers, or rely on the 503 path directly.
 */
async function waitForSessionReady(
  ctx: RouteContext,
  id: string,
): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (ctx.getSession?.(id) !== undefined) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}


export async function handleCommand(
  ctx: RouteContext,
  res: ServerResponse,
  sessionId: string,
  body: unknown,
): Promise<void> {
  // 1. Validate id
  if (!requireValidSessionId(res, sessionId)) return;

  // 2. Require owned
  if (!ctx.owned.has(sessionId)) {
    sendJson(res, 409, {
      error: 'session_not_owned',
      message: `session ${sessionId} is not owned by this process`,
    });
    return;
  }

  // 3. Require turn-accounting — without it we cannot guarantee serialization.
  // Contract: isBusy/reserveTurn/releaseTurn must all be present. An owner
  // that omits any of them is misconfigured; 501 surfaces this clearly.
  if (!ctx.isBusy || !ctx.reserveTurn || !ctx.releaseTurn) {
    sendJson(res, 501, {
      error: 'commands_not_supported',
      message: 'turn accounting (isBusy/reserveTurn/releaseTurn) is not configured on this server',
    });
    return;
  }

  // 4. Parse body
  if (
    typeof body !== 'object' ||
    body === null ||
    !('input' in body) ||
    typeof (body as Record<string, unknown>)['input'] !== 'string'
  ) {
    sendJson(res, 400, { error: 'bad_request', message: 'body must be { input: string }' });
    return;
  }
  const input = (body as Record<string, unknown>)['input'] as string;
  const cwd = ctx.getSessionCwd?.(sessionId) ?? process.cwd();

  // 5. isBusy check — no await between here and reserveTurn (step 6).
  if (ctx.isBusy(sessionId)) {
    sendJson(res, 409, {
      error: 'session_busy',
      message: `session ${sessionId} already has a turn in flight`,
    });
    return;
  }

  // 6. Reserve turn synchronously (no await between isBusy and this call).
  ctx.reserveTurn(sessionId);
  // IncomingMessage.close also fires after the POST body is consumed; only the
  // response's premature close means the waiting browser command went away.
  const disconnected = new AbortController();
  const onDisconnect = (): void => { if (!res.writableEnded) disconnected.abort(); };
  res.on?.('close', onDisconnect);

  try {
    // Ensure registry is initialized (idempotent memo).
    await ensureSlashRegistry();

    // Wait for session to be ready (poll up to 2s).
    if (ctx.getSession && !(await waitForSessionReady(ctx, sessionId))) {
      sendJson(res, 503, {
        error: 'session_not_ready',
        message: 'session is not yet ready — retry in a moment',
      });
      return;
    }

    // Look up command in registry.
    const parsed = parse(input);
    if (!parsed) {
      sendJson(res, 400, { error: 'bad_request', message: 'input must be a slash command (starts with /)' });
      return;
    }

    const cmd = lookup(parsed.name);
    if (!cmd) {
      const suggestion = suggest(parsed.name) ?? undefined;
      sendJson(res, 404, {
        error: 'unknown_command',
        message: `unknown command: ${parsed.name}`,
        ...(suggestion ? { suggestion } : {}),
      });
      return;
    }

    // Check gate list — returns 409 with human-readable reason.
    if (isGated(cmd.name)) {
      sendJson(res, 409, {
        error: 'command_gated',
        message: `command ${cmd.name} is not available on the web surface`,
        reason: gateReason(cmd.name),
      });
      return;
    }

    // Build SlashContext — session must be available if getSession is wired.
    const stats = getStats(sessionId);
    if (!stats) {
      sendJson(res, 503, { error: 'session_not_ready', message: 'session stats not initialized' });
      return;
    }

    // Invariant: session is looked up via the typed RouteContext.getSession —
    // no cast to a wider intersection type. When getSession is wired, we require
    // a defined session before building SlashContext (503 otherwise). When it is
    // absent (attach-only / tests without a wired owner), we accept undefined via
    // buildOptionalSessionRef — callers must not use ctx.session.current there.
    const session: AgentSession | undefined = ctx.getSession?.(sessionId);
    if (ctx.getSession && session === undefined) {
      sendJson(res, 503, {
        error: 'session_not_ready',
        message: 'session object is not available — retry in a moment',
      });
      return;
    }

    const sessionRef = session !== undefined
      ? buildSessionRef(session)
      : buildOptionalSessionRef(undefined);
    const writer = new BufferingWriter();
    const slashCtx = createWebSlashContext(sessionRef, stats, writer, cwd);
    if (ctx.choiceBroker) {
      const broker = ctx.choiceBroker;
      slashCtx.choose = (request) => broker.choose(sessionId, request, disconnected.signal);
      slashCtx.progress = (event) => { broker.progress(sessionId, event); };
    }

    // The owner wraps canonical handlers with persistent accounting and a
    // provider-backed fast controller. This route alone owns the reservation.
    const execution = ctx.executeSessionControl
      ? await ctx.executeSessionControl(sessionId, cmd, slashCtx, parsed.args ?? '')
      : { result: await cmd.handler(slashCtx, parsed.args ?? '') };
    const blocks = writer.toOutputBlocks();
    const control = execution.control ?? normalizeSlashResult(execution.result);

    sendJson(res, 200, { blocks, control, ...(execution.session ? { session: execution.session } : {}) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'command_execution_failed', message });
  } finally {
    res.off?.('close', onDisconnect);
    // Invariant: releaseTurn fires for ALL return paths inside the try block
    // (including gated 409, session_not_ready 503, and thrown exceptions).
    // The 501/400/409 pre-try early returns do not call reserveTurn, so they
    // must NOT call releaseTurn either — this finally only runs after step 6.
    ctx.releaseTurn(sessionId);
  }
}
