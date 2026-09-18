/**
 * Tests for TerminalCompositor — input bottom-pin placement.
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369).
 * Behavior unchanged; shared mock factories live in ./terminal-compositor.test-helpers.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { CupFrameRenderer } from './cup-frame-renderer.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

// Module-level reset mirrors the original monolith's top-level beforeEach:
// clear the process-wide StdinClaim singleton before every test.
beforeEach(() => {
  __resetStdinClaimForTests();
});

describe('TerminalCompositor — input placement (placementMode)', () => {
  // These tests verify the two-regime frame placement controlled by
  // `placementMode` (FramePlacementMode):
  //
  //   'cursor-follow' — fresh session, no committed content. The input frame
  //     sits just below the banner (anchorRow), eliminating the large empty
  //     gap. Multi-line frames (dropdown open) grow downward toward
  //     absoluteBottom. No-banner sessions stay bottom-pinned (anchorRow is
  //     undefined, so cursor-follow falls through to absoluteBottom).
  //
  //   'bottom-pinned' — after the first commitAbove. The input is always at
  //     absoluteBottom (rows-1-extraRows); committed content and overlay grow
  //     upward.
  //
  // History: unconditional bottom-pinning was added to fix a dropdown-push
  // bug in an earlier content-following regime. That fix created a large
  // empty gap on fresh banner sessions. `placementMode` restores top-flow
  // for the pre-commit idle state without the dropdown-push: cursor-follow
  // computes targetBottomRow = min(absoluteBottom, anchorRow-1 + physicalRows),
  // so a 1-line idle frame lands at anchorRow while a multi-line frame grows
  // toward absoluteBottom naturally.

  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
  });

  it('cold start: no banner, no content — frame stays bottom-pinned (cursor-follow with no anchorRow)', async () => {
    // Without a banner (anchorRow undefined), cursor-follow falls through to
    // absoluteBottom because the conditional requires anchorRow !== undefined.
    stdout.rows = 70;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), promptText: '> ' });
    await c.arm();
    const out = writes.all();
    // 1-line idle frame → bottom-pinned at row 69 (70-1).
    expect(out).toContain('\x1b[69;1H');
    c.disarm();
  });

  it('cold start WITH banner: cursor-follow places frame at anchorRow (no gap)', async () => {
    // Fresh session with a 14-row banner (anchorRow=15). Before any commit,
    // placementMode is 'cursor-follow', so the 1-line idle frame sits at
    // anchorRow (row 15), not absoluteBottom (row 69). This eliminates the
    // large empty gap between the banner and the prompt.
    stdout.rows = 70;
    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(), promptText: '> ',
      anchorRow: 15,
    });
    await c.arm();
    const out = writes.all();
    // 1-line idle frame → cursor-follow at row 15 (anchorRow).
    expect(out).toContain('\x1b[15;1H');
    // Must NOT be at row 69 (absoluteBottom).
    expect(out).not.toContain('\x1b[69;1H');
    c.disarm();
  });

  it('cursor-follow transitions to bottom-pinned after first commitAbove', async () => {
    // After the first commit, the frame must snap to absoluteBottom regardless
    // of where cursor-follow had placed it.
    stdout.rows = 70;
    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(), promptText: '> ',
      anchorRow: 15,
    });
    await c.arm();
    // Verify cursor-follow is active (row 15).
    expect(writes.all()).toContain('\x1b[15;1H');
    // First commit flips placementMode to 'bottom-pinned'.
    c.commitAbove('FIRST_COMMIT');
    writes.clear();
    c.setOverlay('AFTER_COMMIT');
    const out = writes.all();
    // Now at absoluteBottom = row 69 (70-1).
    expect(out).toContain('\x1b[69;1H');
    c.disarm();
  });

  it('tall terminal + banner: frame stays bottom-pinned (no content-following) so the dropdown has headroom', async () => {
    // Regression guard for the fresh-session dropdown-jump fix: rows=70,
    // anchorRow=15 (14-row welcome banner). Even with a small committed band
    // sitting near the banner (committedBandBottomRow=16, far above
    // absoluteBottom=69), the next standalone repaint must bottom-pin the input
    // frame — NOT follow the content up to ~row 19. Bottom-pinning is what
    // leaves the empty viewport above the prompt for the completion dropdown to
    // grow into without shoving the input down.
    stdout.rows = 70;
    const c2 = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(), promptText: '> ',
      anchorRow: 15,
    });
    await c2.arm();
    // Manually force a small committedBandBottomRow by patching internal state
    // via the typed cast the compositor tests already use.
    const internals = c2 as unknown as {
      committedBand: string[];
      committedBandTopRow: number;
      committedBandBottomRow: number;
      hasCommitted: boolean;
      placementMode: string;
      logUpdate: { resetGeometry?: () => void };
    };
    internals.committedBand = ['COMMITTED'];
    internals.committedBandTopRow = 16;
    internals.committedBandBottomRow = 16;
    internals.hasCommitted = true;
    // commitAbove flips placementMode to 'bottom-pinned' alongside
    // hasCommitted; manual state injection must mirror both fields.
    internals.placementMode = 'bottom-pinned';
    // Reset CupFrameRenderer geometry so its erase pass on the next render
    // doesn't re-visit the stale previous-frame row (row 69 from arm()).
    internals.logUpdate.resetGeometry?.();
    writes.clear();
    c2.setOverlay('FOLLOW_TEST');
    const out2 = writes.all();
    // Input frame must land at absoluteBottom = row 69 (70-1), NOT follow the
    // band up to ~row 19.
    expect(out2).toContain('\x1b[69;1H');
    // The overlay text must appear in the output (frame rendered).
    expect(out2).toContain('FOLLOW_TEST');
    c2.disarm();
  });

  it('no-banner session: frame stays bottom-pinned regardless of committed content', async () => {
    // Without a banner (anchorRow undefined or ≤1) the frame is always at
    // absoluteBottom = rows-1-extraRows regardless of how many commits have
    // accumulated — this preserves all resize-ghost, shrink-gap, and
    // scrollback-gap invariants.
    stdout.rows = 24;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), promptText: '> ' });
    await c.arm();

    // Commit several lines — with no banner the frame should stay bottom-pinned.
    for (let i = 0; i < 5; i++) {
      c.commitAbove(`LINE_${i}`);
    }
    writes.clear();
    c.setOverlay('AFTER_COMMITS');
    const out = writes.all();

    // Frame must always be at absoluteBottom = rows-1 = 23, regardless of
    // committed content.
    expect(out).toContain('\x1b[23;1H');
    c.disarm();
  });

  it('reserved extraRows: targetBottomRow never enters reserved rows', async () => {
    // extraRows=2 → absoluteBottom = 24-1-2 = 21.
    // With a banner (anchorRow=5) and committed content, the bottom-pinned frame
    // must cap at absoluteBottom=21 — never write into bg-status-bar rows 22-23.
    const mockScrollRegion = {
      withFullScrollRegion<T>(fn: () => T): T { return fn(); },
      getExtraRows(): number { return 2; },
    };
    stdout.rows = 24;
    const c = new TerminalCompositor({
      stdout, stdin, onCancel: vi.fn(), promptText: '> ',
      anchorRow: 5,
      scrollRegion: mockScrollRegion,
    });
    await c.arm();
    // Commit enough lines to fill the viewport; the frame stays bottom-pinned.
    for (let i = 0; i < 25; i++) {
      c.commitAbove(`LINE_${i}`);
    }
    writes.clear();
    c.setOverlay('EXTRA_ROW_TEST');
    const out = writes.all();
    // Collect CUP rows, excluding the eviction-scroll CUP at physicalBottom=24.
    // evictRowsToScrollback writes `\x1b[24;1H\n...` to trigger DECSTBM scroll;
    // that row is intentionally at the physical margin (not a frame content row).
    const physicalBottom = stdout.rows; // 24
    const re = /\x1b\[(\d+);\d+H/g;
    let m: RegExpExecArray | null;
    let maxFrameRow = 0;
    while ((m = re.exec(out)) !== null) {
      const row = parseInt(m[1]!, 10);
      if (row !== physicalBottom) {
        maxFrameRow = Math.max(maxFrameRow, row);
      }
    }
    expect(maxFrameRow).toBeGreaterThan(0);
    // Frame content must stay at or below absoluteBottom = 21 (extraRows=2).
    expect(maxFrameRow).toBeLessThanOrEqual(21);
    c.disarm();
  });
});

// ─── Protocol invariants ─────────────────────────────────────────────────────
//
// These tests guard the externally-governed contracts catalogued in
// docs/tui-invariants.md. Each test names the historical bug it prevents from
// recurring. If you find yourself disabling one of these, you are also opting
// out of the invariant — confirm in the PR description that the contract has
// genuinely changed at the protocol level (VT spec, log-update source) before
// merging.

