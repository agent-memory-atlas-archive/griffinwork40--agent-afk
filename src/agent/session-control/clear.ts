import type { AgentSession } from '../session.js';
import type { SessionStats } from '../../cli/slash/types.js';
import { resetStats } from '../../cli/slash/session-stats.js';

/**
 * Contract: reset the provider conversation, then counters/identity and the
 * optional trusted-skill ledger. Model, permission mode and thinking preference
 * survive; name/sessionId and turn history do not (resetStats owns that policy).
 * A failed reset leaves stats and ledger untouched. Terminal clearing belongs
 * to the caller, as does busy/queue policy and turn reservation.
 *
 * Telegram currently replaces its managed session; Stage 5 must adopt this
 * contract rather than preserving that surface-specific lifecycle operation.
 */
export async function clearConversation(
  session: Pick<AgentSession, 'reset'>,
  stats: SessionStats,
  ledger?: { clear(): void },
): Promise<void> {
  await session.reset();
  resetStats(stats);
  ledger?.clear();
}
