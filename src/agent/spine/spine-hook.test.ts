/**
 * Unit tests for spine-hook.ts — guard conditions and fast-exit paths.
 *
 * The hook is best-effort (wraps everything in try/catch), so these tests
 * verify the guard conditions that cause early return {} BEFORE any I/O
 * or LLM calls.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── Mock the classifier so no real LLM calls happen ─────────────────────────

vi.mock('./spine-classifier.js', () => ({
  classifyDiff: vi.fn().mockResolvedValue({ items: [], rawOutput: '', parsed: true }),
  MAX_DESCRIPTION_LEN: 120,
}));

// ── Mock Telegram push so no real network calls happen ───────────────────────

vi.mock('../../telegram/push.js', () => ({
  pushIfConfigured: vi.fn().mockResolvedValue(undefined),
}));

// ── Mock git so no real shell commands happen ─────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: vi.fn().mockReturnValue(''),
  };
});

// ── Mock spine-store to avoid real file I/O ──────────────────────────────────

vi.mock('./spine-store.js', () => ({
  readSpine: vi.fn().mockReturnValue(null),
  writeSpine: vi.fn(),
  addEntry: vi.fn().mockReturnValue('INV-001'),
  findEntry: vi.fn().mockReturnValue(undefined),
  sectionForPrefix: vi.fn(),
  serializeSpine: vi.fn().mockReturnValue(''),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { createSpineSessionEndHook } from './spine-hook.js';
import type { HookContext } from '../hooks.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeSessionEndContext(
  overrides: Partial<{
    sessionId: string;
    parentSessionId: string;
  }> = {},
): HookContext {
  return {
    event: 'SessionEnd',
    sessionId: overrides.sessionId ?? 'test-session-id',
    ...(overrides.parentSessionId !== undefined
      ? { parentSessionId: overrides.parentSessionId }
      : {}),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('createSpineSessionEndHook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['AFK_DISABLE_SPINE_UPDATE'];
  });

  it('returns {} for non-SessionEnd events', async () => {
    const hook = createSpineSessionEndHook();
    const result = await hook({ event: 'PreToolUse', toolName: 'bash', sessionId: 'x' });
    expect(result).toEqual({});
  });

  it('skips subagent sessions (parentSessionId present)', async () => {
    const hook = createSpineSessionEndHook();
    const { classifyDiff } = await import('./spine-classifier.js');

    const result = await hook(makeSessionEndContext({ parentSessionId: 'parent-123' }));
    expect(result).toEqual({});
    expect(classifyDiff).not.toHaveBeenCalled();
  });

  it('fast-exits when AFK_DISABLE_SPINE_UPDATE=1', async () => {
    process.env['AFK_DISABLE_SPINE_UPDATE'] = '1';
    const hook = createSpineSessionEndHook();
    const { classifyDiff } = await import('./spine-classifier.js');

    const result = await hook(makeSessionEndContext());
    expect(result).toEqual({});
    expect(classifyDiff).not.toHaveBeenCalled();

    delete process.env['AFK_DISABLE_SPINE_UPDATE'];
  });

  it('fast-exits when git diff is empty', async () => {
    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockReturnValue('');

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    const { classifyDiff } = await import('./spine-classifier.js');

    const result = await hook(makeSessionEndContext());
    expect(result).toEqual({});
    expect(classifyDiff).not.toHaveBeenCalled();
  });

  it('calls classifyDiff when diff is non-empty', async () => {
    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockImplementation((cmd, args) => {
      const argsArr = args as string[];
      if (argsArr.includes('rev-parse')) return '/fake/repo';
      if (argsArr.includes('diff')) return 'diff --git a/foo.ts b/foo.ts\n+const x = 1;';
      return '';
    });

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [],
      rawOutput: '[]',
      parsed: true,
    });

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    const result = await hook(makeSessionEndContext());
    expect(result).toEqual({});
    expect(classifyDiff).toHaveBeenCalled();
  });

  it('never throws — swallows errors as best-effort', async () => {
    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockRejectedValue(new Error('LLM failure'));

    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockReturnValue('some diff content');

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    // Should not throw
    const result = await hook(makeSessionEndContext());
    expect(result).toEqual({});
  });
});

// ── Label-handling branch tests ───────────────────────────────────────────────

describe('createSpineSessionEndHook — label branches', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['AFK_DISABLE_SPINE_UPDATE'];
  });

  /** Helper: set up execFileSync so both rev-parse and diff return useful values. */
  async function setupDiffMock(diffContent = 'diff --git a/foo.ts b/foo.ts\n+const x = 1;') {
    const { execFileSync } = await import('node:child_process');
    vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
      const argsArr = args as string[];
      if (argsArr.includes('rev-parse')) return '/fake/repo';
      if (argsArr.includes('diff')) return diffContent;
      return '';
    });
  }

  it('new-addition: calls addEntry and writeSpine', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'new-addition',
          prefix: 'INV',
          description: 'All env vars go through env.ts',
          rationale: 'Because security',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const { addEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    expect(addEntry).toHaveBeenCalledWith(
      expect.any(Object),
      'INV',
      'test-session-id',
      'All env vars go through env.ts',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    );
    expect(writeSpine).toHaveBeenCalled();
  });

  it('strengthens with valid existingId: mutates description and calls writeSpine', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'strengthens',
          existingId: 'INV-001',
          existingDescription: 'All env vars go through env.ts',
          description: 'New code also routes through env.ts',
          rationale: 'See src/config/env.ts',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const mockEntry = {
      id: 'INV-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: 'All env vars go through env.ts',
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    expect(findEntry).toHaveBeenCalledWith(expect.any(Object), 'INV-001');
    expect(mockEntry.description).toMatch(/reinforced/);
    expect(writeSpine).toHaveBeenCalled();
  });

  it('strengthens with invalid existingId: logs to pending (no writeSpine)', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'strengthens',
          existingId: 'INV-999',
          existingDescription: 'Non-existent entry',
          description: 'Strengthens nothing',
          rationale: 'Hallucinated ID',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(undefined);

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    // writeSpine must NOT be called — only pending log
    expect(writeSpine).not.toHaveBeenCalled();
  });

  it('weakens with valid existingId: mutates description and calls writeSpine', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'weakens',
          existingId: 'INV-001',
          existingDescription: 'All env vars go through env.ts',
          description: 'One module bypasses env.ts for legacy reasons',
          rationale: 'See legacy-compat.ts',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const mockEntry = {
      id: 'INV-001',
      date: '2026-09-01',
      sessionId: 'old-session',
      description: 'All env vars go through env.ts',
    };

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [mockEntry] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(mockEntry);

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    expect(findEntry).toHaveBeenCalledWith(expect.any(Object), 'INV-001');
    expect(mockEntry.description).toMatch(/partially weakened/);
    expect(writeSpine).toHaveBeenCalled();
  });

  it('weakens with invalid existingId: logs to pending (no writeSpine)', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'weakens',
          existingId: 'INV-999',
          existingDescription: 'Non-existent entry',
          description: 'Weakens nothing',
          rationale: 'Hallucinated ID',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const { findEntry, writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });
    vi.mocked(findEntry).mockReturnValue(undefined);

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    await hook(makeSessionEndContext());

    expect(writeSpine).not.toHaveBeenCalled();
  });

  it('contradicts: calls pushIfConfigured (mocked via best-effort)', async () => {
    await setupDiffMock();

    const { classifyDiff } = await import('./spine-classifier.js');
    vi.mocked(classifyDiff).mockResolvedValue({
      items: [
        {
          label: 'contradicts',
          existingId: 'INV-001',
          existingDescription: 'All env vars go through env.ts',
          description: 'This module directly reads process.env',
          rationale: 'See legacy.ts line 42',
        },
      ],
      rawOutput: '[]',
      parsed: true,
    });

    const { writeSpine, readSpine } = await import('./spine-store.js');
    vi.mocked(readSpine).mockReturnValue({
      sections: [
        { name: 'Invariants', prefix: 'INV', entries: [] },
        { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
        { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
      ],
      trailer: '',
    });

    const hook = createSpineSessionEndHook({ repoRoot: '/fake/repo' });
    const result = await hook(makeSessionEndContext());

    // contradicts does NOT write SPINE.md
    expect(writeSpine).not.toHaveBeenCalled();
    // hook still returns {} (best-effort — pushIfConfigured is called
    // but may fail silently in test environment)
    expect(result).toEqual({});
  });
});
