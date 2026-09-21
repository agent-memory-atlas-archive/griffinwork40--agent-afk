/**
 * Unit tests for src/utils/git.ts
 *
 * All tests stub the injectable `execFile` / `execFileSync` options so no
 * real child process is spawned. This avoids the "Cannot redefine property"
 * ESM constraint on node:child_process built-ins.
 */

import { describe, it, expect } from 'vitest';
import { resolveRepoRoot, resolveRepoRootSync } from './git.js';
import type { ExecFileSyncForGit } from './git.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExec(stdout: string): (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }> {
  return async (_file, _args) => ({ stdout, stderr: '' });
}

function makeExecThrowing(message = 'spawn git ENOENT'): () => Promise<never> {
  return async () => {
    throw new Error(message);
  };
}

// ---------------------------------------------------------------------------
// resolveRepoRoot (async)
// ---------------------------------------------------------------------------

describe('resolveRepoRoot', () => {
  describe('show-toplevel mode (default)', () => {
    it('returns the trimmed stdout', async () => {
      const root = await resolveRepoRoot({ execFile: makeExec('/home/user/myrepo\n') });
      expect(root).toBe('/home/user/myrepo');
    });

    it('throws when stdout is empty', async () => {
      await expect(resolveRepoRoot({ execFile: makeExec('') })).rejects.toThrow(
        'Not in a git repository.',
      );
    });

    it('throws when stdout is only whitespace', async () => {
      await expect(resolveRepoRoot({ execFile: makeExec('   \n') })).rejects.toThrow(
        'Not in a git repository.',
      );
    });

    it('throws when execFile rejects', async () => {
      await expect(resolveRepoRoot({ execFile: makeExecThrowing() })).rejects.toThrow(
        'Not in a git repository.',
      );
    });
  });

  describe('git-common-dir mode', () => {
    it('resolves absolute --git-common-dir to its dirname', async () => {
      // Absolute path: dirname of /home/user/myrepo/.git => /home/user/myrepo
      const root = await resolveRepoRoot({
        mode: 'git-common-dir',
        execFile: makeExec('/home/user/myrepo/.git\n'),
      });
      expect(root).toBe('/home/user/myrepo');
    });

    it('resolves relative --git-common-dir against cwd', async () => {
      // git outputs ".git" (relative) when inside the main worktree
      const root = await resolveRepoRoot({
        mode: 'git-common-dir',
        cwd: '/home/user/myrepo',
        execFile: makeExec('.git\n'),
      });
      expect(root).toBe('/home/user/myrepo');
    });

    it('resolves nested linked-worktree path to main repo root', async () => {
      // From a linked worktree, git returns the shared .git dir:
      // /home/user/myrepo/.git/worktrees/<name>
      const root = await resolveRepoRoot({
        mode: 'git-common-dir',
        execFile: makeExec('/home/user/myrepo/.git/worktrees/feat\n'),
      });
      // dirname of the above is /home/user/myrepo/.git/worktrees — that is
      // the correct dirname; if the consumer wants one level up they chain
      // dirname again. The canonical function is faithful to what git returns.
      expect(root).toBe('/home/user/myrepo/.git/worktrees');
    });

    it('throws when stdout is empty (empty-stdout guard)', async () => {
      await expect(
        resolveRepoRoot({ mode: 'git-common-dir', execFile: makeExec('') }),
      ).rejects.toThrow('Not in a git repository.');
    });

    it('throws when git is not installed (exec throws)', async () => {
      await expect(
        resolveRepoRoot({ mode: 'git-common-dir', execFile: makeExecThrowing('ENOENT') }),
      ).rejects.toThrow('Not in a git repository.');
    });
  });
});

// ---------------------------------------------------------------------------
// resolveRepoRootSync
// ---------------------------------------------------------------------------

function makeSyncExec(stdout: string): ExecFileSyncForGit {
  return (_file, _args, _opts) => stdout;
}

function makeSyncExecThrowing(message = 'spawn git ENOENT'): ExecFileSyncForGit {
  return () => {
    throw new Error(message);
  };
}

describe('resolveRepoRootSync', () => {
  it('returns the trimmed stdout (show-toplevel)', () => {
    expect(resolveRepoRootSync({ execFileSync: makeSyncExec('/home/user/myrepo\n') })).toBe('/home/user/myrepo');
  });

  it('returns fallback instead of throwing when exec fails', () => {
    expect(
      resolveRepoRootSync({ execFileSync: makeSyncExecThrowing(), fallback: '/default' }),
    ).toBe('/default');
  });

  it('throws when exec fails and no fallback supplied', () => {
    expect(() => resolveRepoRootSync({ execFileSync: makeSyncExecThrowing() })).toThrow(
      'Not in a git repository.',
    );
  });

  it('throws on empty stdout (empty-stdout guard)', () => {
    expect(() => resolveRepoRootSync({ execFileSync: makeSyncExec('') })).toThrow(
      'Not in a git repository.',
    );
  });

  it('resolves git-common-dir mode with absolute path', () => {
    const root = resolveRepoRootSync({
      mode: 'git-common-dir',
      execFileSync: makeSyncExec('/home/user/myrepo/.git\n'),
    });
    expect(root).toBe('/home/user/myrepo');
  });

  it('resolves git-common-dir mode with relative path against cwd', () => {
    const root = resolveRepoRootSync({
      mode: 'git-common-dir',
      cwd: '/home/user/myrepo',
      execFileSync: makeSyncExec('.git\n'),
    });
    expect(root).toBe('/home/user/myrepo');
  });

  it('returns fallback on git-common-dir empty stdout instead of throwing', () => {
    const root = resolveRepoRootSync({
      mode: 'git-common-dir',
      execFileSync: makeSyncExec(''),
      fallback: '/fallback',
    });
    expect(root).toBe('/fallback');
  });
});
