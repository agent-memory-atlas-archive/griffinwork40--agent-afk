/**
 * Anthropic-provider branch of the Telegram session factory.
 *
 * Extracted verbatim from `src/telegram.ts`'s `createSession` closure. The
 * behaviour-preserving asymmetries called out inline (which executors receive
 * `cwd`, which receive the trace writer) are load-bearing -- see each comment.
 */

import { AnthropicDirectProvider } from '../agent/providers/index.js';
import { topLevelSurfaceAllowedTools } from '../agent/tools/top-level-allowlist.js';
import { wireTelegramExecutors } from './wire-telegram-executors.js';
import { finalizeTelegramSession } from './session-lifecycle.js';
import type { AgentSession } from '../agent/session.js';
import type { TelegramSessionBuildContext } from './session-context.js';

export async function buildAnthropicTelegramSession(
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

  const telegramApiKey = sessionConfig.apiKey ?? config.apiKey ?? '';
  const telegramBaseUrl = config.baseUrl;
  // OpenAI-compatible endpoint (distinct from telegramBaseUrl, which is
  // Anthropic-only) -- threaded for parity with chat.ts's cliConfig.openaiBaseUrl wiring.
  const telegramOpenaiBaseUrl = sessionConfig.openaiBaseUrl ?? config.openaiBaseUrl;

  // Shared executor + background + drain scaffolding.
  const wiring = wireTelegramExecutors({
    apiKey: telegramApiKey,
    model: sessionConfig.model,
    layeredBasePrompt,
    sessionCwd,
    traceWriter,
    chatId,
    threadId,
    wireExtras: {
      // Behaviour-preserving asymmetry: the writer reaches the manager, the
      // `agent` executor and compose nodes, but NOT the `skill` executor or
      // the nested skill-executor factory (no `skillTraceWriter`) --
      // matching the pre-refactor wiring.
      ...(telegramBaseUrl !== undefined ? { baseUrl: telegramBaseUrl } : {}),
      ...(telegramOpenaiBaseUrl !== undefined ? { openaiBaseUrl: telegramOpenaiBaseUrl } : {}),
      ...(workspaceStore !== undefined ? { workspaceStore } : {}),
    },
  });
  const { subagentExecutor, skillExecutor, composeExecutor } = wiring.executors;

  const allowedTools = topLevelSurfaceAllowedTools(mcpManager?.getMcpToolWireNames() ?? []);
  const directProvider = new AnthropicDirectProvider({
    permissions: { allowedTools },
    subagentExecutor,
    skillExecutor,
    composeExecutor,
    ...(mcpManager !== undefined ? { mcpManager } : {}),
    workspaceStore,
    // Tag the presence file (~/.afk/state/presence/<id>.json) and
    // get_runtime_state as the Telegram surface. Without this the provider
    // defaults to 'cli' (anthropic-direct/index.ts) and `/watch`
    // mis-classifies Telegram sessions as CLI.
    surface: 'telegram',
  });

  // Anthropic branch: provider-specific config is only `baseUrl`.
  return finalizeTelegramSession(
    directProvider,
    { ...(telegramBaseUrl !== undefined ? { baseUrl: telegramBaseUrl } : {}) },
    ctx,
    wiring,
  );
}
