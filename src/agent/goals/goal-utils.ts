/**
 * Goal key derivation utilities.
 *
 * Provides `projectKeyForCwd()` — the single source of truth for mapping a
 * working directory to a durable StateStore key under the `"goals"` namespace.
 *
 * Key scheme
 * ----------
 * - Inside a git repo: `proj.<basename>-<sha1_hex8>`, where the SHA-1 is
 *   computed over the common-dir root (so linked worktrees share a goal with
 *   the main checkout).
 * - Outside a git repo (or when git is unavailable): `'current'` — the
 *   original global key, preserved for backward compatibility.
 *
 * The derived key is sanitized to match the StateStore key pattern
 * `/^[A-Za-z0-9_.-]+$/` and capped at 128 characters.
 *
 * @module agent/goals/goal-utils
 */

import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { resolveRepoRootSync } from '../../utils/git.js';

/** StateStore key used when no git repo can be resolved. */
export const FALLBACK_KEY = 'current';

/** Maximum length of a StateStore key (platform constraint). */
const MAX_KEY_LEN = 128;

/**
 * Derive the StateStore key for the goal that belongs to the git repo
 * containing `cwd`. Falls back to `'current'` when not inside a git repo.
 *
 * Worktree-aware: uses `git-common-dir` mode so all linked worktrees of the
 * same repository share the same goal key (and therefore the same goal).
 *
 * @param cwd - Working directory to resolve. Defaults to `process.cwd()`.
 * @param execFileSync - Injectable executor for test isolation.
 */
export function projectKeyForCwd(
  cwd?: string,
  execFileSync?: Parameters<typeof resolveRepoRootSync>[0] extends undefined
    ? never
    : import('../../utils/git.js').ResolveRepoRootSyncOptions['execFileSync'],
): string {
  const root = resolveRepoRootSync({
    cwd: cwd ?? process.cwd(),
    mode: 'git-common-dir',
    fallback: '',
    execFileSync,
  });

  if (!root) return FALLBACK_KEY;

  // Cap only the slug so the 8-char hex hash is always preserved.
  // key = "proj." (5) + slug + "-" (1) + hash (8) = slug budget: MAX_KEY_LEN - 14
  const slug = sanitizeKeySegment(basename(root)).slice(0, MAX_KEY_LEN - 14);
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 8);
  const key = `proj.${slug}-${hash}`;

  return key;
}

/**
 * Sanitize an arbitrary string to only the characters allowed in a StateStore
 * key (`/^[A-Za-z0-9_.-]+$/`). Any character outside that set is replaced with
 * `_`. An empty result (e.g. a name that was entirely special chars) falls back
 * to `_`.
 */
function sanitizeKeySegment(s: string): string {
  const sanitized = s.replace(/[^A-Za-z0-9_.-]/g, '_');
  return sanitized || '_';
}
