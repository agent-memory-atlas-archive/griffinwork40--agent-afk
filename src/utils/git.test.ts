/**
 * Unit tests for src/utils/git.ts
 *
 * All tests stub the injectable `execFile` / `execFileSync` options so no
 * real child process is spawned. This avoids the "Cannot redefine property"
 * ESM constraint on node:child_process built-ins.
 */

import { describe, it, expect, beforeEach, vi, type MockInstance } from 'vitest';
import type { ExecFileSyncForGit } from './git.js';

// vi.mock hoists above imports, so git.ts receives the mocked execFileSync.
// The mock defaults to the real implementation; individual tests override via
// mockExecFileSync (the typed reference returned by vi.mocked()).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

// Must import AFTER vi.mock so the module receives the mocked binding.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
const { resolveRepoRoot, resolveRepoRootSync, clearRepoRootSyncCache } = await import('./git.js');
const { execFileSync: _mockRef } = await import('node:child_process');
const mockExecFileSync = _mockRef as unknown as MockInstance;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExec(stdout: string): (file: string, args: string[], opts?: { cwd?: string }) => Promise<{ stdout: string; stderr: string }> {
  return async (_file, _args, _opts) => ({ stdout, stderr: '' });
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
      // git outputs ".git" (relative) when inside the main worktree.
      // The mock returns an absolute path so path.resolve() is not called
      // with a POSIX-only cwd literal — on Windows path.resolve('/home/...',
      // '.git') would prepend the drive letter, breaking the assertion (#703).
      const root = await resolveRepoRoot({
        mode: 'git-common-dir',
        cwd: '/home/user/myrepo',
        execFile: makeExec('/home/user/myrepo/.git\n'),
      });
      expect(root).toBe('/home/user/myrepo');
    });

    it('resolves nested linked-worktree path to main repo root', async () => {
      // From a linked worktree, git rev-parse --git-common-dir returns the
      // shared .git directory of the main repo: /home/user/myrepo/.git
      const root = await resolveRepoRoot({
        mode: 'git-common-dir',
        execFile: makeExec('/home/user/myrepo/.git\n'),
      });
      // dirname of /home/user/myrepo/.git is /home/user/myrepo — the main repo root.
      expect(root).toBe('/home/user/myrepo');
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
    // Use an absolute mock output so path.resolve() is not called with a
    // POSIX-only cwd literal — on Windows path.resolve('/home/...', '.git')
    // prepends the drive letter, breaking the assertion (#703).
    const root = resolveRepoRootSync({
      mode: 'git-common-dir',
      cwd: '/home/user/myrepo',
      execFileSync: makeSyncExec('/home/user/myrepo/.git\n'),
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

// ---------------------------------------------------------------------------
// resolveRepoRootSync — memoization / LRU cache
// ---------------------------------------------------------------------------

describe('resolveRepoRootSync memoization', () => {
  beforeEach(() => {
    clearRepoRootSyncCache();
    mockExecFileSync.mockReset();
  });

  it('cache hit: second call with same cwd skips execFileSync', () => {
    // vi.mock replaces the real execFileSync at the module level, so
    // production code (no custom executor) exercises the cache path.
    mockExecFileSync.mockReturnValue('/home/user/myrepo\n');

    resolveRepoRootSync({ cwd: '/home/user/myrepo' });
    resolveRepoRootSync({ cwd: '/home/user/myrepo' });
    expect(mockExecFileSync).toHaveBeenCalledTimes(1); // second call hits cache
  });

  it('cache miss after clearRepoRootSyncCache', () => {
    mockExecFileSync.mockReturnValue('/home/user/myrepo\n');

    resolveRepoRootSync({ cwd: '/home/user/myrepo' });
    clearRepoRootSyncCache();
    resolveRepoRootSync({ cwd: '/home/user/myrepo' });
    expect(mockExecFileSync).toHaveBeenCalledTimes(2); // cache cleared → re-executes
  });

  it('LRU eviction: 11th distinct cwd evicts the first entry', () => {
    mockExecFileSync.mockImplementation((_file: string, _args: string[], opts: Record<string, unknown>) => {
      return `${(opts as { cwd: string }).cwd}\n`;
    });

    // Fill cache with 10 entries (cap), then add an 11th.
    for (let i = 0; i < 11; i++) {
      resolveRepoRootSync({ cwd: `/home/user/repo${i}` });
    }
    expect(mockExecFileSync).toHaveBeenCalledTimes(11); // all 11 are cold misses

    // Re-request the first entry — it was evicted, so execFileSync fires again.
    // This insert also evicts repo1 (now the oldest) to stay at cap.
    resolveRepoRootSync({ cwd: '/home/user/repo0' });
    expect(mockExecFileSync).toHaveBeenCalledTimes(12);

    // repo1 was evicted when repo0 was re-inserted, so this is a cache miss.
    // Reinserting repo1 evicts repo2 (now the oldest).
    resolveRepoRootSync({ cwd: '/home/user/repo1' });
    expect(mockExecFileSync).toHaveBeenCalledTimes(13);

    // repo3 is still cached — verify a surviving entry hits the cache.
    resolveRepoRootSync({ cwd: '/home/user/repo3' });
    expect(mockExecFileSync).toHaveBeenCalledTimes(13); // cache hit, no new call
  });

  it('custom execFileSync bypasses cache (test-isolation contract)', () => {
    let callCount = 0;
    const exec: ExecFileSyncForGit = (_file, _args, _opts) => {
      callCount += 1;
      return '/home/user/myrepo\n';
    };

    resolveRepoRootSync({ cwd: '/home/user/myrepo', execFileSync: exec });
    resolveRepoRootSync({ cwd: '/home/user/myrepo', execFileSync: exec });
    expect(callCount).toBe(2); // cache bypassed each time
  });
});

// ---------------------------------------------------------------------------
// resolveRepoRootSync — non-git directory and timeout/spawn-error edge cases
// ---------------------------------------------------------------------------

describe('resolveRepoRootSync — non-git-dir and spawn errors', () => {
  it('throws "Not in a git repository." when cwd is not a git repo', () => {
    // Simulate git exiting non-zero (execFileSync throws for non-zero exit).
    const exec: ExecFileSyncForGit = () => {
      throw new Error('Command failed: git rev-parse --show-toplevel');
    };
    expect(() => resolveRepoRootSync({ cwd: '/tmp/not-a-repo', execFileSync: exec })).toThrow(
      'Not in a git repository.',
    );
  });

  it('returns fallback when cwd is not a git repo and fallback is supplied', () => {
    const exec: ExecFileSyncForGit = () => {
      throw new Error('fatal: not a git repository');
    };
    expect(
      resolveRepoRootSync({ cwd: '/tmp/not-a-repo', execFileSync: exec, fallback: '/fallback' }),
    ).toBe('/fallback');
  });

  it('throws on spawn timeout (ETIMEDOUT)', () => {
    // git can time out in unusual environments (e.g. NFS mounts, slow network
    // filesystems). execFileSync throws with ETIMEDOUT in that case.
    const exec: ExecFileSyncForGit = () => {
      const err = new Error('spawnSync git ETIMEDOUT');
      (err as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      throw err;
    };
    expect(() => resolveRepoRootSync({ execFileSync: exec })).toThrow('Not in a git repository.');
  });

  it('returns fallback on spawn timeout when fallback is supplied', () => {
    const exec: ExecFileSyncForGit = () => {
      const err = new Error('spawnSync git ETIMEDOUT');
      (err as NodeJS.ErrnoException).code = 'ETIMEDOUT';
      throw err;
    };
    expect(resolveRepoRootSync({ execFileSync: exec, fallback: '/safe' })).toBe('/safe');
  });

  it('throws when git is not on PATH (ENOENT)', () => {
    const exec: ExecFileSyncForGit = () => {
      const err = new Error('spawnSync git ENOENT');
      (err as NodeJS.ErrnoException).code = 'ENOENT';
      throw err;
    };
    expect(() => resolveRepoRootSync({ execFileSync: exec })).toThrow('Not in a git repository.');
  });
});

// ---------------------------------------------------------------------------
// resolveRepoRootSync — --separate-git-dir edge case (git-common-dir mode)
// ---------------------------------------------------------------------------

describe('resolveRepoRootSync — --separate-git-dir via git-common-dir', () => {
  it('resolves a repo whose .git is a separate-git-dir (absolute external path)', () => {
    // When a repo is cloned with `--separate-git-dir /external/gitdir`,
    // `git rev-parse --git-common-dir` returns the absolute path to that
    // external directory (e.g. /external/gitdir). dirname() of that path is
    // the intended repo identity root for /resume filtering purposes.
    const root = resolveRepoRootSync({
      mode: 'git-common-dir',
      execFileSync: makeSyncExec('/external/gitdir\n'),
    });
    // dirname('/external/gitdir') === '/external'
    expect(root).toBe('/external');
  });

  it('resolves a worktree whose git-common-dir is the main repo .git (absolute)', () => {
    // Standard linked worktree: git outputs the main .git dir path.
    // e.g. /home/user/main-repo/.git  → dirname → /home/user/main-repo
    const root = resolveRepoRootSync({
      mode: 'git-common-dir',
      execFileSync: makeSyncExec('/home/user/main-repo/.git\n'),
    });
    expect(root).toBe('/home/user/main-repo');
  });

  it('resolves relative git-common-dir output against supplied cwd', () => {
    // When inside the main worktree, git outputs the relative path ".git".
    // path.resolve(cwd, '.git') should give the absolute git dir, and
    // dirname of that is the repo root.
    const root = resolveRepoRootSync({
      mode: 'git-common-dir',
      cwd: '/home/user/main-repo',
      execFileSync: makeSyncExec('.git\n'),
    });
    expect(root).toBe('/home/user/main-repo');
  });
});
