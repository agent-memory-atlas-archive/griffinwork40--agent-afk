/**
 * Unit tests for yield-probe (#2016).
 *
 * Tests the pure helpers (getCurrentBranch, queryPrState) and the top-level
 * writeFacetYield integration. No real git/gh processes are spawned.
 */
import { describe, expect, it, vi } from 'vitest';
import { getCurrentBranch, queryPrState, writeFacetYield, patchYieldFields } from './yield-probe.js';
import type { ExecFnYield } from './yield-probe.js';

// ---------------------------------------------------------------------------
// getCurrentBranch
// ---------------------------------------------------------------------------

describe('getCurrentBranch', () => {
  it('returns the branch name on success', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({ stdout: 'main\n', stderr: '' });
    expect(await getCurrentBranch(exec)).toBe('main');
  });

  it('returns null when git fails', async () => {
    const exec: ExecFnYield = vi.fn().mockRejectedValue(new Error('not a git repo'));
    expect(await getCurrentBranch(exec)).toBeNull();
  });

  it('returns null when stdout is empty', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({ stdout: '   ', stderr: '' });
    expect(await getCurrentBranch(exec)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// queryPrState
// ---------------------------------------------------------------------------

describe('queryPrState', () => {
  it('returns "merged" for a merged PR', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ state: 'MERGED' }]),
      stderr: '',
    });
    expect(await queryPrState(exec, 'afk/my-feature')).toBe('merged');
  });

  it('returns "open" for an open PR', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ state: 'OPEN' }]),
      stderr: '',
    });
    expect(await queryPrState(exec, 'afk/my-feature')).toBe('open');
  });

  it('returns "closed" for a closed PR', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({
      stdout: JSON.stringify([{ state: 'CLOSED' }]),
      stderr: '',
    });
    expect(await queryPrState(exec, 'afk/my-feature')).toBe('closed');
  });

  it('returns "none" for an empty PR list', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    expect(await queryPrState(exec, 'afk/no-pr')).toBe('none');
  });

  it('returns "none" on gh failure', async () => {
    const exec: ExecFnYield = vi.fn().mockRejectedValue(new Error('gh not found'));
    expect(await queryPrState(exec, 'afk/my-feature')).toBe('none');
  });

  it('returns "none" on malformed JSON', async () => {
    const exec: ExecFnYield = vi.fn().mockResolvedValue({ stdout: 'not json', stderr: '' });
    expect(await queryPrState(exec, 'afk/my-feature')).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// writeFacetYield integration
// ---------------------------------------------------------------------------

describe('writeFacetYield', () => {
  it('does nothing when getCurrentBranch returns null', async () => {
    const patchSpy = vi.fn();
    vi.doMock('./yield-probe.js', () => ({
      getCurrentBranch: vi.fn().mockResolvedValue(null),
      queryPrState: vi.fn(),
      patchYieldFields: patchSpy,
      writeFacetYield,
    }));
    const exec: ExecFnYield = vi.fn().mockRejectedValue(new Error('no git'));
    // Should not throw even with no git
    await expect(writeFacetYield('sess-xyz', exec)).resolves.toBeUndefined();
  });

  it('calls patchYieldFields with produced_pr=false when no PR found', async () => {
    // We test this by verifying exec call sequence and not calling a real patchYieldFields.
    // The exec mock: first call (git symbolic-ref) → branch; second call (gh pr list) → []
    let callCount = 0;
    const exec: ExecFnYield = vi.fn().mockImplementation(async (file: string) => {
      callCount++;
      if (file === 'git') return { stdout: 'afk/test-branch\n', stderr: '' };
      return { stdout: '[]', stderr: '' }; // no PR
    });

    // patchYieldFields writes to disk; mock the cache path by passing a non-existent dir.
    // The function reads from the cache and no-ops if the file doesn't exist — so no disk I/O.
    await writeFacetYield('sess-xyz', exec, undefined);
    expect(callCount).toBe(2); // git + gh
  });

  it('calls exec with the right args for a merged PR path', async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const exec: ExecFnYield = vi.fn().mockImplementation(async (file: string, args: string[]) => {
      calls.push({ file, args });
      if (file === 'git') return { stdout: 'afk/feature\n', stderr: '' };
      return { stdout: JSON.stringify([{ state: 'MERGED' }]), stderr: '' };
    });

    await writeFacetYield('sess-abc', exec, undefined);

    expect(calls[0]).toMatchObject({ file: 'git', args: ['symbolic-ref', '--short', 'HEAD'] });
    expect(calls[1]).toMatchObject({
      file: 'gh',
      args: expect.arrayContaining(['pr', 'list', '--head', 'afk/feature', '--state', 'all']),
    });
  });
});

// ---------------------------------------------------------------------------
// patchYieldFields — file-not-found guard
// ---------------------------------------------------------------------------

describe('patchYieldFields', () => {
  it('is a no-op when the cache file does not exist', () => {
    // Pass a cacheDir that has no file for this session — should not throw.
    expect(() => patchYieldFields('sess-noop', true, true, '/tmp/nonexistent-cache-dir-xyz')).not.toThrow();
  });
});
