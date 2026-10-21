/**
 * POST /api/sessions/:id/commands — execute a native slash command on a
 * web-owned session and return the buffered output as JSON.
 *
 * Ordering (Amendment A2):
 *   1. Validate session id
 *   2. Require owned
 *   3. Parse body
 *   4. isBusy → 409
 *   5. reserveTurn (synchronous)
 *   6. try { registry + gate + ctx + handler } finally { releaseTurn }
 */

import type { ServerResponse } from 'node:http';
import { sendJson, requireValidSessionId } from './routes.js';
import type { RouteContext } from './routes.js';
import type { SlashResult } from '../cli/slash/types.js';
import type { CommandControl } from './shared/command-wire.js';
import { ensureSlashRegistry } from './slash-registry.js';
import { parse, lookup, suggest } from '../cli/slash/registry.js';
import { isGated, gateReason } from './command-gate.js';
import { BufferingWriter } from './writer.buffer.js';
import { getStats, buildSessionRef } from './session-owner.slash.js';
import { createWebSlashContext } from './slash-context.web.js';

/** Poll owner.getSession up to 2s (40 × 50ms) before giving up. */
async function waitForSessionReady(
  ctx: RouteContext & { getSession?: (id: string) => unknown },
  id: string,
): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (ctx.getSession?.(id) !== undefined) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

/** Normalise any SlashResult variant into the wire CommandControl shape. */
export function normalizeSlashResult(result: SlashResult): CommandControl {
  if (result === 'continue') return { kind: 'continue' };
  if (result === 'exit') return { kind: 'exit' };
  if (result === 'forward') return { kind: 'forward' };
  if (typeof result === 'object' && result !== null) {
    // 'rerun' is the discriminant for { rerun: string } — no cast needed after narrowing.
    if ('rerun' in result) return { kind: 'rerun', input: result.rerun };
    // 'kind' discriminates { kind: 'submit' | 'prefill'; message: string }.
    if ('kind' in result && result.kind === 'submit') return { kind: 'submit', message: result.message };
    if ('kind' in result && result.kind === 'prefill') return { kind: 'prefill', message: result.message };
  }
  return { kind: 'continue' };
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

  // 3. Parse body
  if (typeof body !== 'object' || body === null || !('input' in body) || typeof (body as Record<string, unknown>)['input'] !== 'string') {
    sendJson(res, 400, { error: 'bad_request', message: 'body must be { input: string }' });
    return;
  }
  const input = (body as Record<string, unknown>)['input'] as string;
  const cwd = ctx.getSessionCwd?.(sessionId) ?? process.cwd();

  // 4. isBusy check
  if (ctx.isBusy(sessionId)) {
    sendJson(res, 409, {
      error: 'session_busy',
      message: `session ${sessionId} already has a turn in flight`,
    });
    return;
  }

  // 5. Reserve turn synchronously
  ctx.reserveTurn?.(sessionId);

  const ctxWithGet = ctx as RouteContext & { getSession?: (id: string) => unknown };

  try {
    // Ensure registry is initialized (static import, idempotent memo).
    await ensureSlashRegistry();

    // Wait for session to be ready (poll up to 2s).
    if (ctxWithGet.getSession && !(await waitForSessionReady(ctxWithGet, sessionId))) {
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

    // Check gate list.
    // Gated: release via finally (below) then return 409.
    // Spec A2 shows explicit releaseTurn here but finally is equivalent and safer.
    if (isGated(cmd.name)) {
      sendJson(res, 409, {
        error: 'command_gated',
        message: `command ${cmd.name} is not available on the web surface`,
        reason: gateReason(cmd.name),
      });
      return;
    }

    // Build context.
    const stats = getStats(sessionId);
    if (!stats) {
      sendJson(res, 503, { error: 'session_not_ready', message: 'session stats not initialized' });
      return;
    }

    const session = ctxWithGet.getSession?.(sessionId) as import('../agent/session/agent-session.js').AgentSession | undefined;
    const sessionRef = buildSessionRef(session);
    const writer = new BufferingWriter();
    const slashCtx = createWebSlashContext(sessionRef, stats, writer, cwd);

    // Execute handler.
    const result = await cmd.handler(slashCtx, parsed.args ?? '');
    const block = writer.toOutputBlock();
    const control = normalizeSlashResult(result);

    sendJson(res, 200, { blocks: [block], control });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendJson(res, 500, { error: 'command_execution_failed', message });
  } finally {
    // releaseTurn fires for ALL return paths inside the try block (including
    // gated 409, session_not_ready 503, and thrown exceptions).
    ctx.releaseTurn?.(sessionId);
  }
}
