/** Web-owned accounting and stable-id projection around canonical session controls.
 * Admission belongs exclusively to the commands route, not this adapter.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { clearConversation } from '../agent/session-control/index.js';
import { FastModeController } from '../agent/fast-mode.js';
import { resolveModelId } from '../agent/session/model-resolution.js';
import { SessionLedgerWriter } from '../agent/session-ledger.js';
import { getSessionLedgerDir, getSessionLedgerPath } from '../paths.js';
import { recordTurn } from '../cli/slash/session-stats.js';
import { saveSession } from '../cli/session-store.js';
import type { SessionAutosaver } from '../cli/session-autosave.js';
import type { AgentSession } from '../agent/session/agent-session.js';
import type { SlashCommand, SlashContext, SessionStats } from '../cli/slash/types.js';
import type { CommandControl } from './shared/command-wire.js';

export interface SessionControlResult {
  result: Awaited<ReturnType<SlashCommand['handler']>>;
  control?: CommandControl;
  session?: { model?: string; name?: string };
}

/** One instance per owned session, including before provider construction. */
export class WebSessionControl {
  readonly fastMode: FastModeController;
  private projection: SessionLedgerWriter | undefined;
  private bound = false;

  constructor(
    readonly id: string,
    private readonly session: AgentSession,
    private readonly stats: SessionStats,
    private readonly onMetadata: (metadata: { model: string; name?: string }) => void,
    fastMode = new FastModeController(),
    private readonly hasCustomEndpoint = false,
  ) { this.fastMode = fastMode; }

  /** Same controller passed to the owning provider, never a UI-only toggle. */
  context(): Pick<SlashContext, 'fastMode' | 'getFastModeContext'> {
    return {
      fastMode: this.fastMode,
      getFastModeContext: () => ({
        resolvedModelId: resolveModelId(this.stats.model) ?? String(this.stats.model),
        // WebSessionWiring currently explicitly constructs this provider family.
        providerFamily: 'anthropic-direct',
        hasCustomEndpoint: this.hasCustomEndpoint,
        executionPath: 'top-level',
      }),
    };
  }

  /** Drain helper receives this saver WITHOUT its legacy second stats update. */
  autosaver(onError: (error: unknown) => void): SessionAutosaver {
    this.stats.sessionId = this.id;
    this.stats.source = 'web';
    let reported = false;
    return {
      stats: this.stats,
      saveTurn: (input, text, metadata, tools) => {
        try {
          recordTurn(this.stats, input, text, metadata, tools);
          this.stats.sessionId = this.id;
          this.persist();
        } catch (error) {
          if (!reported) { reported = true; onError(error); }
        }
      },
    };
  }

  async execute(cmd: SlashCommand, ctx: SlashContext, args: string): Promise<SessionControlResult> {
    if (cmd.name === '/clear') {
      // Do not infer success from shared handler's 'continue': it catches errors.
      await clearConversation(this.session, this.stats);
      await this.session.waitForInitialization();
      this.stats.sessionId = this.id;
      await this.resetProjection();
      this.persist();
      this.onMetadata({ model: String(this.stats.model) });
      ctx.out.success('Conversation history cleared.');
      return { result: 'continue', control: { kind: 'clear' } };
    }
    Object.assign(ctx, this.context());
    const result = await cmd.handler(ctx, args);
    this.stats.sessionId = this.id;
    this.onMetadata({ model: String(this.stats.model), ...(this.stats.name ? { name: this.stats.name } : {}) });
    if (cmd.name === '/model' || cmd.name === '/name') {
      // Metadata is authoritative even when validation rejected the requested value.
      this.persist();
      return { result, session: { model: String(this.stats.model), ...(this.stats.name ? { name: this.stats.name } : {}) } };
    }
    return { result };
  }

  /** Stable browser filename, CURRENT provider journal for /resume. */
  private persist(): void {
    saveSession({ ...this.stats, sessionId: this.session.sessionId ?? this.id }, this.id);
  }

  /** Canonical reset seals the OLD provider ledger and mints a new provider id.
   * Browser ownership must keep its original id, so replace its cleared projection
   * and mirror future output there. Provider journals/ledgers remain untouched.
   * Clients reconnect SSE without Last-Event-ID on the clear control.
   */
  private async resetProjection(): Promise<void> {
    await this.projection?.close('reset');
    mkdirSync(getSessionLedgerDir(this.id), { recursive: true });
    writeFileSync(getSessionLedgerPath(this.id), '', { mode: 0o600 });
    this.projection = new SessionLedgerWriter(this.id);
    this.projection.record({ kind: 'meta', sessionId: this.id, model: String(this.stats.model), ...(this.stats.cwd ? { cwd: this.stats.cwd } : {}) });
    if (this.bound) return;
    this.bound = true;
    const sideband = this.session.pushSidebandEvent.bind(this.session);
    this.session.pushSidebandEvent = (event) => {
      if (this.session.sessionId !== this.id) this.projection?.recordEvent(event);
      sideband(event);
    };
    const elicitation = this.session.recordLedgerElicitation.bind(this.session);
    this.session.recordLedgerElicitation = (reqId, request) => {
      if (this.session.sessionId !== this.id) this.projection?.record({ kind: 'elicitation', reqId, request });
      elicitation(reqId, request);
    };
    const send = this.session.sendMessageStream.bind(this.session);
    const control = this;
    this.session.sendMessageStream = async function* (content) {
      // In case a provider retains its id, it already writes this projection.
      const mirror = control.session.sessionId !== control.id;
      if (mirror) {
        const text = typeof content === 'string' ? content : content.map((b) => b.type === 'text' ? b.text : '').join('\n');
        control.projection?.recordUser(text);
      }
      for await (const event of send(content)) {
        if (mirror) control.projection?.recordEvent(event);
        yield event;
      }
    };
  }

  async close(): Promise<void> { await this.projection?.close('close'); }
}
