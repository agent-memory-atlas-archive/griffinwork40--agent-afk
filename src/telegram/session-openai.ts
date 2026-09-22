/**
 * OpenAI-compatible-provider branch of the Telegram session factory.
 *
 * Extracted verbatim from `src/telegram.ts`'s `createSession` closure.
 *
 * Invariant: the provider is constructed EXPLICITLY here rather than letting
 * AgentSession build it internally, so this branch holds a handle to wire
 * path-approval. Without that handle `getGrantManager()` stays undefined and
 * BOTH path-approval and the bash interpreter denylist silently fail OPEN for
 * OpenAI-compatible Telegram sessions (PR #202 review H1).
 */

import { OpenAICompatibleProvider } from '../agent/providers/index.js';
import { wireTelegramExecutors } from './wire-telegram-executors.js';
import { finalizeTelegramSession } from './session-lifecycle.js';
import type { AgentSession } from '../agent/session.js';
import type { TelegramSessionBuildContext } from './session-context.js';

export async function buildOpenAiTelegramSession(
  ctx: TelegramSessionBuildContext,
): Promise<AgentSession> {
  const {
    sessionConfig,
    config,
    layeredBasePrompt,
    sessionCwd,
    traceWriter,
    mcpManager,
    workspaceStore,
    chatId,
    threadId,
  } = ctx;

  // OpenAI-compatible endpoint for this branch's own top-level session
  // (parity with the Anthropic branch's telegramOpenaiBaseUrl).
  const codexOpenaiBaseUrl = sessionConfig.openaiBaseUrl ?? config.openaiBaseUrl;

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
      ...(codexOpenaiBaseUrl !== undefined ? { openaiBaseUrl: codexOpenaiBaseUrl } : {}),
      ...(workspaceStore !== undefined ? { workspaceStore } : {}),
    },
  });
  const { subagentExecutor, skillExecutor, composeExecutor } = wiring.executors;

  // permissionMode is intentionally omitted here: AgentSession defaults
  // to 'default' (post-C2 fix), which is the correct mode for Telegram
  // sessions that rely on hook-based permission enforcement.
  // surface:'telegram' prevents the presence file mis-labeling as 'cli'.
  const codexProvider = new OpenAICompatibleProvider({
    surface: 'telegram',
    subagentExecutor,
    skillExecutor,
    composeExecutor,
    ...(mcpManager !== undefined ? { mcpManager } : {}),
    workspaceStore,
  });

  // OpenAI branch: provider-specific config is only `openaiBaseUrl`.
  // Sets config.openaiBaseUrl -> effectiveBaseURL (openai-compatible/index.ts)
  // so this top-level OpenAI Telegram session reaches the configured shim
  // instead of defaulting to api.openai.com.
  return finalizeTelegramSession(
    codexProvider,
    { ...(codexOpenaiBaseUrl !== undefined ? { openaiBaseUrl: codexOpenaiBaseUrl } : {}) },
    ctx,
    wiring,
  );
}
