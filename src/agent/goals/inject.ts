/**
 * Config injector for active goals — mirrors `injectHotMemory` pattern.
 *
 * Call at session construction (alongside `injectHotMemory`) to populate
 * `config.goalPrompt`. The fragment is placed between hot memory and the
 * `# Environment` block by the system-prompt assembler.
 *
 * Does not mutate the original config — returns a shallow copy when a goal
 * is active, or the original config when none.
 *
 * @module agent/goals/inject
 */

import type { AgentConfig } from '../types/config-types.js';
import { buildGoalPromptFragment } from './goal-prompt.js';
import { projectKeyForCwd } from './goal-utils.js';

export function injectGoalPrompt(config: AgentConfig): AgentConfig {
  const projectKey = projectKeyForCwd(config.cwd);
  const fragment = buildGoalPromptFragment(projectKey);
  if (!fragment) return config;
  return { ...config, goalPrompt: fragment };
}
