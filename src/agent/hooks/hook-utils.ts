/**
 * Shared predicates and helpers for hook implementations.
 *
 * @module agent/hooks/hook-utils
 */

import type { HookContext } from '../hooks.js';

/**
 * Predicate: does this hook context belong to a sub-agent session?
 * Handles the `SubagentStopContext` variant, which may lack the field.
 */
export function isSubagentContext(context: HookContext): boolean {
  return 'parentSessionId' in context && context.parentSessionId !== undefined;
}
