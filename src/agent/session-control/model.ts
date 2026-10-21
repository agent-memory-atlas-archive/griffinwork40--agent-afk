import type { AgentSession } from '../session.js';
import type { AgentModelInput } from '../types.js';
import type { SessionStats } from '../../cli/slash/types.js';
import { isValidModelArg } from '../session/model-validate.js';
import { MODEL_ALIASES_HINT, unconfiguredSlotError } from '../session/model-slots.js';

export type SetSessionModelResult =
  | { ok: true; model: AgentModelInput }
  | { ok: false; message: string };

/** Validates before provider mutation; provider errors leave stats unchanged. */
export async function setSessionModel(
  session: Pick<AgentSession, 'setModel'>,
  stats: SessionStats,
  target: string,
): Promise<SetSessionModelResult> {
  // Aliases are case-insensitive; full wire IDs (e.g. HuggingFace names)
  // retain their spelling instead of being damaged by surface normalization.
  const trimmed = target.trim();
  const lower = trimmed.toLowerCase();
  const model = MODEL_ALIASES_HINT.includes(lower) ? lower : trimmed;
  if (!isValidModelArg(model)) {
    return { ok: false, message: `Unknown model: ${model}. Aliases: ${MODEL_ALIASES_HINT.join(', ')}  (or a full model id)` };
  }
  const unconfigured = unconfiguredSlotError(model);
  if (unconfigured) return { ok: false, message: unconfigured };
  await session.setModel(model as AgentModelInput);
  stats.model = model as AgentModelInput;
  return { ok: true, model: stats.model };
}
