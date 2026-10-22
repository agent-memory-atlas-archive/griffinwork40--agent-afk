/**
 * Web-surface lifecycle handlers for /fork, /resume, and /exit.
 *
 * All three run inside the command route's reserveTurn/releaseTurn bracket —
 * admission is never bypassed here.
 *
 * /fork   — writes a sidecar fork via the shared forkStoredSession helper
 *           (same function the REPL uses), creates a new owned session from
 *           the fork's journal/history, and returns { kind:'navigate' }.
 *
 * /resume — with no args: emits a structured list of saved sessions using
 *           the Stage 2 block helpers (returns 'continue').
 *           with an id/name: creates a new owned session resumed from the
 *           stored sidecar and returns { kind:'navigate', sessionId }.
 *
 * /exit   — marks the session ended in its persisted sidecar and returns
 *           { kind:'exit' }. The session object stays in the owner map so
 *           in-flight SSE tails can drain; it is removed on the next create
 *           or server restart.
 *
 * Clipboard-using and terminal-spawn paths from the REPL fork handler are
 * replaced by the navigate control: the dashboard selects the new session.
 */

import { forkStoredSession, findSession, listSessions, saveSession } from '../cli/session-store.js';
import { forkJournal } from '../agent/journal/index.js';
import { formatCost } from '../cli/format-utils.js';
import { writeKeyValue, writeList } from '../cli/slash/output-blocks.format.js';
import { resumeConfigFor } from '../cli/resume-session.js';
import type { SlashContext } from '../cli/slash/types.js';
import type { CommandControl } from './shared/command-wire.js';
import type { SessionOwner } from './session-owner.js';

// ---------------------------------------------------------------------------
// /exit
// ---------------------------------------------------------------------------

/**
 * Mark an owned session as ended and persist the sidecar so the session
 * appears as completed in the sidebar. Returns the wire exit control.
 */
export async function handleWebExit(
  _owner: SessionOwner,
  sessionId: string,
  ctx: SlashContext,
): Promise<CommandControl> {
  // Persist ended state so the sidebar shows the session as completed.
  const stats = ctx.stats;
  saveSession(
    { ...stats, sessionId: ctx.session.current.sessionId ?? sessionId },
    sessionId,
    { closeTime: true, exitReason: 'exit-command' },
  );
  ctx.out.info('Session ended. Start a new session or select one from the sidebar.');
  return { kind: 'exit' };
}

// ---------------------------------------------------------------------------
// /resume
// ---------------------------------------------------------------------------

/** Relative timestamp for session listing (same logic as resume.ts). */
function fmtWhen(ts: number): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return '—';
  const diffMs = Date.now() - ts;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD}d ago`;
  const d = new Date(ts);
  const mon = d.toLocaleString('en-US', { month: 'short' });
  return `${mon} ${d.getDate()}`;
}

/**
 * /resume with no argument — emit a structured list of saved sessions.
 * Returns 'continue'; no navigation occurs.
 */
export async function handleWebResumeList(ctx: SlashContext): Promise<'continue'> {
  const currentCwd = ctx.stats.cwd ?? process.cwd();
  const all = listSessions();
  if (all.length === 0) {
    ctx.out.info('No saved sessions. Start a session — it autosaves each turn.');
    return 'continue';
  }
  const local = all.filter((e) => e.cwd === currentCwd);
  const entries = local.length > 0 ? local : all;
  const title = local.length > 0
    ? `Saved sessions (${entries.length}) — this directory`
    : `Saved sessions (${entries.length}) — all directories`;

  writeList(
    ctx.out,
    {
      title,
      items: entries.slice(0, 50).map((e) => ({
        text: e.name ?? e.id,
        description: `${fmtWhen(e.savedAt)} · ${e.model} · ${e.totalTurns} turn${e.totalTurns === 1 ? '' : 's'} · ${formatCost(e.totalCostUsd)}`,
      })),
    },
    () => {
      ctx.out.line(title);
      for (const e of entries.slice(0, 50)) {
        ctx.out.line(`  ${(e.name ?? e.id).padEnd(32)}  ${fmtWhen(e.savedAt).padEnd(9)}  ${e.model}`);
      }
    },
  );
  ctx.out.line();
  ctx.out.info('Use /resume <name-or-id> to resume a session.');
  return 'continue';
}

/**
 * /resume <id-or-name> — create a new owned session resumed from the stored
 * sidecar and return a navigate control pointing at it.
 */
export async function handleWebResumeTarget(
  owner: SessionOwner,
  _sessionId: string,
  ctx: SlashContext,
  target: string,
): Promise<CommandControl | 'continue'> {
  const found = findSession(target);
  if (!found) {
    ctx.out.warn(`No saved session: ${target}`);
    return 'continue';
  }

  // Guard: resuming the live session would tear it down and lose unsaved turns.
  const currentSdkId = ctx.session.current.sessionId;
  const targetSdkId = found.data.sessionId;
  const isSame =
    (currentSdkId !== undefined && targetSdkId !== undefined && currentSdkId === targetSdkId) ||
    (currentSdkId !== undefined && currentSdkId === found.id);
  if (isSame) {
    ctx.out.warn(`Already on session ${found.data.name ?? found.id}.`);
    return 'continue';
  }

  const label = found.data.name ?? found.id;
  ctx.out.info(`Resuming session ${label} …`);

  const resumeConfig = resumeConfigFor({
    id: found.id,
    resumeId: found.data.sessionId ?? found.id,
    stored: found.data,
  });

  try {
    const model = String(found.data.model ?? ctx.stats.model);
    const cwd = found.data.cwd ?? ctx.stats.cwd ?? process.cwd();
    const newInfo = await owner.create({ model, cwd }, resumeConfig);
    ctx.out.success(`Resumed ${label}  (new session id: ${newInfo.id})`);

    // Emit key-value summary of the resumed session.
    writeKeyValue(
      ctx.out,
      {
        entries: [
          { key: 'session', value: label },
          { key: 'model', value: model },
          { key: 'turns', value: String(found.data.totalTurns) },
          { key: 'cost', value: formatCost(found.data.totalCostUsd) },
        ],
      },
      () => {
        ctx.out.line(`  session  ${label}`);
        ctx.out.line(`  model    ${model}`);
        ctx.out.line(`  turns    ${found.data.totalTurns}`);
      },
    );

    return { kind: 'navigate', sessionId: newInfo.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.out.error(`Failed to resume session: ${msg}`);
    return 'continue';
  }
}

// ---------------------------------------------------------------------------
// /fork
// ---------------------------------------------------------------------------

/**
 * /fork — duplicate the current session into a new owned session and return
 * a navigate control pointing at the fork.
 *
 * Reuses forkStoredSession (the same helper the REPL uses) so sidecar
 * semantics are identical. The tab-spawn and clipboard paths from the REPL
 * are replaced by the navigate control: the dashboard selects the fork.
 */
export async function handleWebFork(
  owner: SessionOwner,
  _sessionId: string,
  ctx: SlashContext,
): Promise<CommandControl | 'continue'> {
  if (ctx.stats.totalTurns === 0) {
    ctx.out.warn('Nothing to fork yet — no turns in this session.');
    return 'continue';
  }

  let forkId: string;
  let forkPath: string;
  try {
    ({ id: forkId, path: forkPath } = forkStoredSession(ctx.stats));
  } catch (err) {
    ctx.out.error(`Could not fork: ${err instanceof Error ? err.message : String(err)}`);
    return 'continue';
  }

  // Best-effort journal copy (same as REPL).
  if (ctx.stats.sessionId) {
    try { await ctx.session.current.messageJournal?.flush(); } catch { /* best-effort */ }
    forkJournal(ctx.stats.sessionId, forkId);
  }

  ctx.out.success(`Forked  ${forkPath}`);

  const model = String(ctx.stats.model);
  const cwd = ctx.stats.cwd ?? process.cwd();

  // Build a resume config from the fork sidecar so the new session starts
  // with the forked conversation history.
  const resumeConfig = resumeConfigFor({
    id: forkId,
    resumeId: forkId,
    stored: {
      sessionId: forkId,
      model,
      startedAt: ctx.stats.sessionStartTime,
      savedAt: Date.now(),
      totalTurns: ctx.stats.totalTurns,
      totalCostUsd: ctx.stats.totalCostUsd,
      totalTokens: ctx.stats.totalTokens,
      totalDurationMs: ctx.stats.totalDurationMs,
      turns: [...ctx.stats.turns],
      forkedFrom: ctx.stats.sessionId,
      forkedAt: Date.now(),
      cwd,
      source: 'web',
    },
  });

  try {
    const newInfo = await owner.create({ model, cwd }, resumeConfig);
    ctx.out.info('This session continues here, untouched. The fork carries the conversation only.');
    return { kind: 'navigate', sessionId: newInfo.id };
  } catch (err) {
    ctx.out.error(`Fork created but could not start new session: ${err instanceof Error ? err.message : String(err)}`);
    // The sidecar fork exists — user can /resume it manually.
    ctx.out.info(`Resume the fork with: /resume ${forkId}`);
    return 'continue';
  }
}
