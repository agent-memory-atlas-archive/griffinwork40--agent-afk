/**
 * Tests for the `afk branch prune` classification logic.
 *
 * Exercises `parseGhPrState`, `parseCommitsAhead`, `classify`, and the
 * end-to-end `runBranchPrune` with a fully-stubbed exec function — no real
 * git or gh processes are spawned.
 *
 * @module cli/commands/branch.test
 */

import { describe, it, expect, vi } from 'vitest';
import {
  parseGhPrState,
  parseCommitsAhead,
  classify,
  runBranchPrune,
} from '../../agent/branch/branch-prune.js';
import type { ExecForBranchPrune } from '../../agent/branch/branch-prune.js';

// ---------------------------------------------------------------------------
// parseGhPrState
// ---------------------------------------------------------------------------

describe('parseGhPrState', () => {
  it('returns "merged" for a merged PR', () => {
    expect(parseGhPrState(JSON.stringify([{ state: 'MERGED' }]))).toBe('merged');
  });

  it('returns "merged" for lowercase state', () => {
    expect(parseGhPrState(JSON.stringify([{ state: 'merged' }]))).toBe('merged');
  });

  it('returns "open" for an open PR', () => {
    expect(parseGhPrState(JSON.stringify([{ state: 'OPEN' }]))).toBe('open');
  });

  it('returns "closed" for a closed PR', () => {
    expect(parseGhPrState(JSON.stringify([{ state: 'CLOSED' }]))).toBe('closed');
  });

  it('returns "none" for an empty array (no PR found)', () => {
    expect(parseGhPrState(JSON.stringify([]))).toBe('none');
  });

  it('returns "none" for invalid JSON', () => {
    expect(parseGhPrState('not-json')).toBe('none');
  });

  it('returns "none" for an empty string', () => {
    expect(parseGhPrState('')).toBe('none');
  });

  it('returns "none" for an unknown state string', () => {
    expect(parseGhPrState(JSON.stringify([{ state: 'UNKNOWN' }]))).toBe('none');
  });

  it('uses only the first PR when multiple are returned', () => {
    expect(
      parseGhPrState(JSON.stringify([{ state: 'MERGED' }, { state: 'OPEN' }])),
    ).toBe('merged');
  });
});

// ---------------------------------------------------------------------------
// parseCommitsAhead
// ---------------------------------------------------------------------------

describe('parseCommitsAhead', () => {
  it('returns the integer from clean git output', () => {
    expect(parseCommitsAhead('3\n')).toBe(3);
  });

  it('returns 0 for "0"', () => {
    expect(parseCommitsAhead('0\n')).toBe(0);
  });

  it('returns 0 for non-numeric output (conservative)', () => {
    expect(parseCommitsAhead('not-a-number')).toBe(0);
  });

  it('returns 0 for an empty string', () => {
    expect(parseCommitsAhead('')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// classify
// ---------------------------------------------------------------------------

describe('classify', () => {
  describe('open PR', () => {
    it('always keeps an open PR regardless of commits ahead', () => {
      expect(classify('open', 0).verdict).toBe('keep');
      expect(classify('open', 5).verdict).toBe('keep');
    });

    it('reports PR is open as the reason', () => {
      expect(classify('open', 0).reason).toMatch(/open/i);
    });
  });

  describe('merged PR', () => {
    it('prunes when PR is merged (even if commits appear ahead)', () => {
      expect(classify('merged', 0).verdict).toBe('prune');
      expect(classify('merged', 2).verdict).toBe('prune');
    });

    it('reports PR merged as the reason', () => {
      expect(classify('merged', 0).reason).toMatch(/merged/i);
    });
  });

  describe('closed PR', () => {
    it('prunes when closed and no commits ahead', () => {
      expect(classify('closed', 0).verdict).toBe('prune');
    });

    it('keeps when closed but has commits ahead of base', () => {
      expect(classify('closed', 3).verdict).toBe('keep');
    });

    it('mentions commit count in the keep reason', () => {
      expect(classify('closed', 3).reason).toContain('3');
    });
  });

  describe('no PR found', () => {
    it('prunes when no PR and no commits ahead', () => {
      expect(classify('none', 0).verdict).toBe('prune');
    });

    it('keeps when no PR but has commits ahead (play it safe)', () => {
      expect(classify('none', 5).verdict).toBe('keep');
    });

    it('mentions commit count in the keep reason', () => {
      expect(classify('none', 5).reason).toContain('5');
    });
  });
});

// ---------------------------------------------------------------------------
// runBranchPrune — end-to-end with a stubbed exec
// ---------------------------------------------------------------------------

describe('runBranchPrune', () => {
  /**
   * Build a stub exec function.
   *
   * Responses are keyed by the joined command string so we can target
   * individual git / gh invocations precisely.
   */
  function buildExec(
    responses: Record<string, { stdout: string; stderr?: string; throws?: boolean }>,
  ): ExecForBranchPrune {
    return async (file, args) => {
      const key = [file, ...args].join(' ');
      const match = Object.entries(responses).find(([k]) => key.includes(k));
      if (!match) {
        return { stdout: '', stderr: '' };
      }
      const [, response] = match;
      if (response.throws) {
        throw new Error(`stub: ${key}`);
      }
      return { stdout: response.stdout, stderr: response.stderr ?? '' };
    };
  }

  // Shared remote branch listing output
  const LS_REMOTE_MERGED = [
    'abc123\trefs/heads/afk/feat-merged',
    'def456\trefs/heads/afk/feat-open',
    'ghi789\trefs/heads/afk/feat-closed-ahead',
    'jkl012\trefs/heads/afk/feat-orphan-clean',
  ].join('\n');

  it('returns empty candidates when no branches exist', async () => {
    const exec = buildExec({ 'ls-remote': { stdout: '' } });
    const result = await runBranchPrune({
      execFn: exec,
      remote: 'origin',
      baseBranch: 'main',
      branchPrefix: 'afk/',
      dryRun: true,
      cwd: '/tmp/repo',
    });
    expect(result.candidates).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
  });

  it('classifies a merged-PR branch as prune', async () => {
    const exec = buildExec({
      'ls-remote': { stdout: 'abc123\trefs/heads/afk/feat-merged\n' },
      'gh pr list --head afk/feat-merged': {
        stdout: JSON.stringify([{ state: 'MERGED' }]),
      },
      'rev-list --count main..origin/afk/feat-merged': { stdout: '0\n' },
    });

    const result = await runBranchPrune({
      execFn: exec,
      dryRun: true,
      cwd: '/tmp/repo',
    });

    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]!.verdict).toBe('prune');
    expect(result.candidates[0]!.prState).toBe('merged');
    // Dry-run: nothing actually deleted
    expect(result.deleted).toHaveLength(0);
  });

  it('classifies an open-PR branch as keep', async () => {
    const exec = buildExec({
      'ls-remote': { stdout: 'def456\trefs/heads/afk/feat-open\n' },
      'gh pr list --head afk/feat-open': {
        stdout: JSON.stringify([{ state: 'OPEN' }]),
      },
      'rev-list --count main..origin/afk/feat-open': { stdout: '3\n' },
    });

    const result = await runBranchPrune({ execFn: exec, dryRun: true, cwd: '/tmp/repo' });

    expect(result.candidates[0]!.verdict).toBe('keep');
    expect(result.candidates[0]!.prState).toBe('open');
  });

  it('classifies a closed-PR-with-commits-ahead branch as keep', async () => {
    const exec = buildExec({
      'ls-remote': { stdout: 'ghi789\trefs/heads/afk/feat-closed-ahead\n' },
      'gh pr list --head afk/feat-closed-ahead': {
        stdout: JSON.stringify([{ state: 'CLOSED' }]),
      },
      'rev-list --count main..origin/afk/feat-closed-ahead': { stdout: '2\n' },
    });

    const result = await runBranchPrune({ execFn: exec, dryRun: true, cwd: '/tmp/repo' });

    expect(result.candidates[0]!.verdict).toBe('keep');
    expect(result.candidates[0]!.commitsAhead).toBe(2);
  });

  it('classifies a no-PR clean orphan branch as prune', async () => {
    const exec = buildExec({
      'ls-remote': { stdout: 'jkl012\trefs/heads/afk/feat-orphan-clean\n' },
      'gh pr list --head afk/feat-orphan-clean': { stdout: JSON.stringify([]) },
      'rev-list --count main..origin/afk/feat-orphan-clean': { stdout: '0\n' },
    });

    const result = await runBranchPrune({ execFn: exec, dryRun: true, cwd: '/tmp/repo' });

    expect(result.candidates[0]!.verdict).toBe('prune');
    expect(result.candidates[0]!.prState).toBe('none');
  });

  it('classifies a no-PR branch with commits ahead as keep', async () => {
    const exec = buildExec({
      'ls-remote': { stdout: 'abc999\trefs/heads/afk/no-pr-with-work\n' },
      'gh pr list --head afk/no-pr-with-work': { stdout: JSON.stringify([]) },
      'rev-list --count main..origin/afk/no-pr-with-work': { stdout: '4\n' },
    });

    const result = await runBranchPrune({ execFn: exec, dryRun: true, cwd: '/tmp/repo' });

    expect(result.candidates[0]!.verdict).toBe('keep');
    expect(result.candidates[0]!.commitsAhead).toBe(4);
  });

  it('does NOT delete branches when dryRun is true', async () => {
    const deleteCalled = vi.fn();
    const exec: ExecForBranchPrune = async (file, args) => {
      if (args.includes('--delete')) deleteCalled();
      if (args.includes('ls-remote')) {
        return { stdout: 'abc\trefs/heads/afk/to-prune\n', stderr: '' };
      }
      if (args.includes('pr')) return { stdout: JSON.stringify([{ state: 'MERGED' }]), stderr: '' };
      if (args.includes('rev-list')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    await runBranchPrune({ execFn: exec, dryRun: true, cwd: '/tmp/repo' });
    expect(deleteCalled).not.toHaveBeenCalled();
  });

  it('actually deletes prune-classified branches when execute is true', async () => {
    const deletedBranches: string[] = [];
    const exec: ExecForBranchPrune = async (file, args) => {
      if (args.includes('--delete')) {
        const idx = args.indexOf('--delete');
        deletedBranches.push(args[idx + 1] ?? '');
        return { stdout: '', stderr: '' };
      }
      if (args.includes('ls-remote')) {
        return { stdout: 'abc\trefs/heads/afk/to-prune\n', stderr: '' };
      }
      if (args.includes('pr')) return { stdout: JSON.stringify([{ state: 'MERGED' }]), stderr: '' };
      if (args.includes('rev-list')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    const result = await runBranchPrune({ execFn: exec, dryRun: false, cwd: '/tmp/repo' });
    expect(deletedBranches).toContain('afk/to-prune');
    expect(result.deleted).toContain('afk/to-prune');
  });

  it('captures a warning when ls-remote fails', async () => {
    const exec: ExecForBranchPrune = async () => {
      throw new Error('network unreachable');
    };

    const result = await runBranchPrune({ execFn: exec, dryRun: true, cwd: '/tmp/repo' });
    expect(result.warnings.some((w) => w.includes('[ERROR]'))).toBe(true);
    expect(result.candidates).toHaveLength(0);
  });

  it('handles a failed git push --delete gracefully', async () => {
    const exec: ExecForBranchPrune = async (file, args) => {
      if (args.includes('--delete')) throw new Error('remote: ref not found');
      if (args.includes('ls-remote')) {
        return { stdout: 'abc\trefs/heads/afk/to-prune\n', stderr: '' };
      }
      if (args.includes('pr')) return { stdout: JSON.stringify([{ state: 'MERGED' }]), stderr: '' };
      if (args.includes('rev-list')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    const result = await runBranchPrune({ execFn: exec, dryRun: false, cwd: '/tmp/repo' });
    expect(result.deleted).toHaveLength(0);
    expect(result.warnings.some((w) => w.includes('[ERROR]'))).toBe(true);
    // Candidate verdict should have been updated to 'error'
    expect(result.candidates[0]!.verdict).toBe('error');
  });

  it('sets correct remoteBranch and shortName on each candidate', async () => {
    const exec = buildExec({
      'ls-remote': { stdout: 'abc\trefs/heads/afk/my-feature\n' },
      'gh pr list': { stdout: JSON.stringify([{ state: 'MERGED' }]) },
      'rev-list': { stdout: '0\n' },
    });

    const result = await runBranchPrune({
      execFn: exec,
      remote: 'upstream',
      dryRun: true,
      cwd: '/tmp/repo',
    });

    expect(result.candidates[0]!.shortName).toBe('afk/my-feature');
    expect(result.candidates[0]!.remoteBranch).toBe('upstream/afk/my-feature');
  });

  it('gh failure falls back to "none" PR state and uses commit-ahead for classification', async () => {
    const exec: ExecForBranchPrune = async (file, args) => {
      if (file === 'gh') throw new Error('gh: command not found');
      if (args.includes('ls-remote')) {
        return { stdout: 'abc\trefs/heads/afk/no-gh\n', stderr: '' };
      }
      // 0 commits ahead → prune (no PR + no ahead = safe to prune)
      if (args.includes('rev-list')) return { stdout: '0\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };

    const result = await runBranchPrune({ execFn: exec, dryRun: true, cwd: '/tmp/repo' });
    expect(result.candidates[0]!.prState).toBe('none');
    expect(result.candidates[0]!.verdict).toBe('prune');
  });
});
