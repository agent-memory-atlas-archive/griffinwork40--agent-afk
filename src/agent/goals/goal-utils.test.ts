/**
 * Unit tests for goal-utils.ts — project key derivation.
 *
 * `projectKeyForCwd` wraps `resolveRepoRootSync` from `src/utils/git.ts`.
 * We use the injectable `execFileSync` option so these tests never spawn a
 * real `git` process and are fully portable.
 */

import { describe, expect, it } from 'vitest';
import { projectKeyForCwd, FALLBACK_KEY } from './goal-utils.js';
import type { ExecFileSyncForGit } from '../../utils/git.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build an injectable execFileSync stub that returns `root` as the git
 * common-dir (pointing to `root/.git` so dirname resolves back to `root`).
 */
function makeGitStub(root: string): ExecFileSyncForGit {
  return (_file, _args, _opts) => `${root}/.git\n`;
}

/** Stub that simulates "not a git repo" by throwing. */
const notGitStub: ExecFileSyncForGit = () => {
  throw Object.assign(new Error('fatal: not a git repository'), { status: 128 });
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('projectKeyForCwd', () => {
  it('returns FALLBACK_KEY when not in a git repo', () => {
    const key = projectKeyForCwd('/tmp/not-a-repo', notGitStub);
    expect(key).toBe(FALLBACK_KEY);
    expect(key).toBe('current');
  });

  it('returns a project-scoped key starting with "proj." for a git repo', () => {
    const key = projectKeyForCwd('/home/user/my-project', makeGitStub('/home/user/my-project'));
    expect(key).toMatch(/^proj\./);
  });

  it('includes the repo basename in the key', () => {
    const key = projectKeyForCwd('/home/user/agent-afk', makeGitStub('/home/user/agent-afk'));
    expect(key).toContain('agent-afk');
  });

  it('appends an 8-character hex hash', () => {
    const key = projectKeyForCwd('/home/user/my-repo', makeGitStub('/home/user/my-repo'));
    // Format: proj.<basename>-<8hexchars>
    expect(key).toMatch(/^proj\.[A-Za-z0-9_.-]+-[0-9a-f]{8}$/);
  });

  it('produces different keys for different repo roots', () => {
    const keyA = projectKeyForCwd('/home/user/repo-a', makeGitStub('/home/user/repo-a'));
    const keyB = projectKeyForCwd('/home/user/repo-b', makeGitStub('/home/user/repo-b'));
    expect(keyA).not.toBe(keyB);
  });

  it('produces the same key for the same repo root regardless of cwd', () => {
    const root = '/home/user/shared-repo';
    const stub = makeGitStub(root);
    const keyA = projectKeyForCwd('/home/user/shared-repo/src', stub);
    const keyB = projectKeyForCwd('/home/user/shared-repo/tests', stub);
    expect(keyA).toBe(keyB);
  });

  it('sanitizes repo names with special characters', () => {
    const root = '/home/user/my repo (special)!';
    const key = projectKeyForCwd(root, makeGitStub(root));
    // Key must only contain allowed StateStore characters
    expect(key).toMatch(/^[A-Za-z0-9_.-]+$/);
  });

  it('caps the key at 128 characters', () => {
    const longName = 'a'.repeat(200);
    const root = `/home/user/${longName}`;
    const key = projectKeyForCwd(root, makeGitStub(root));
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key).toMatch(/^[A-Za-z0-9_.-]+$/);
  });

  it('produces a key matching the StateStore pattern /^[A-Za-z0-9_.-]+$/', () => {
    const roots = [
      '/home/user/agent-afk',
      '/Users/dev/my.project',
      '/opt/apps/app_v2',
    ];
    for (const root of roots) {
      const key = projectKeyForCwd(root, makeGitStub(root));
      expect(key).toMatch(/^[A-Za-z0-9_.-]+$/);
    }
  });
});

describe('FALLBACK_KEY', () => {
  it('equals "current" for backward compatibility', () => {
    expect(FALLBACK_KEY).toBe('current');
  });
});
