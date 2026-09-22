/**
 * xAI / Grok provider branch of the Telegram session factory.
 *
 * Mirrors {@link buildOpenAiTelegramSession} grant/MCP/hook wiring, but
 * constructs {@link XaiProvider} so dual endpoints + SuperGrok OAuth work.
 * Never sets `openaiBaseUrl` from global OpenAI shim config (Grok uses
 * `resolveXaiEndpoint` / optional slot `xaiBaseUrl` only).
 *
 * @module telegram/session-xai
 */

import { XaiProvider } from '../agent/providers/xai/index.js';
import { resolveXaiConstructionAuthMode } from '../agent/providers/xai/force-mode.js';
import { wireTelegramExecutors } from './wire-telegram-executors.js';
import { finalizeTelegramSession } from './session-lifecycle.js';
import type { AgentSession } from '../agent/session.js';
import type { TelegramSessionBuildContext } from './session-context.js';

export async function buildXaiTelegramSession(
  ctx: TelegramSessionBuildContext & { providerName: 'xai' | 'xai-oauth' },
): Promise<AgentSession> {
  const {
    sessionConfig,
    layeredBasePrompt,
    sessionCwd,
    traceWriter,
    mcpManager,
    chatId,
    threadId,
    providerName,
  } = ctx;

  // Shared executor + background + drain scaffolding.
  const wiring = wireTelegramExecutors({
    apiKey: sessionConfig.apiKey,
    model: sessionConfig.model,
    layeredBasePrompt,
    sessionCwd,
    traceWriter,
    chatId,
    threadId,
    wireExtras: {
      // Invariant: do NOT forward config.openaiBaseUrl -- XaiProvider ignores
      // AFK_OPENAI_BASE_URL and uses resolveXaiEndpoint + optional xaiBaseUrl.
      ...(sessionConfig.xaiBaseUrl !== undefined ? { xaiBaseUrl: sessionConfig.xaiBaseUrl } : {}),
    },
  });
  const { subagentExecutor, skillExecutor, composeExecutor } = wiring.executors;

  // Slot/provider-forced oauth vs auto-routed apikey construction.
  const authMode = resolveXaiConstructionAuthMode(providerName, providerName === 'xai-oauth');
  const xaiProvider = new XaiProvider({
    surface: 'telegram',
    subagentExecutor,
    skillExecutor,
    composeExecutor,
    ...(authMode !== undefined ? { authMode } : {}),
    ...(mcpManager !== undefined ? { mcpManager } : {}),
  });

  // xAI branch: provider-specific config is only `xaiBaseUrl`.
  // Invariant: do NOT set openaiBaseUrl here (XaiProvider ignores it).
  return finalizeTelegramSession(
    xaiProvider,
    { ...(sessionConfig.xaiBaseUrl !== undefined ? { xaiBaseUrl: sessionConfig.xaiBaseUrl } : {}) },
    ctx,
    wiring,
  );
}
