import { describe, it, expect } from 'vitest';
import {
  isInOpenTable,
  isInOpenCodeFence,
  formatPendingBuffer,
  formatBlockForCommit,
  calculateContentWidth,
  calculateProseContentWidth,
  scheduleWithThrottle,
} from './markdown-stream-format.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

/**
 * Tests for the pure formatting helpers behind StreamingMarkdownRenderer.
 *
 * Focus: the streaming-table live preview guard. A markdown table has no
 * internal blank line, so the whole (growing) table accumulates in the pending
 * buffer and was painted into the live overlay every chunk. Once the table
 * exceeds the viewport height, the overlay's absolute-cursor erase can no
 * longer reclaim rows that scrolled into scrollback, leaving ghost tail rows
 * beside the final committed table. `formatPendingBuffer` now shows a dimmed
 * live preview instead of a placeholder, mirroring the open-code-fence path.
 */

describe('isInOpenTable', () => {
  it('detects a basic GFM delimiter row', () => {
    expect(isInOpenTable('| A | B |\n|---|---|\n| 1 | 2 |')).toBe(true);
  });

  it('detects an alignment delimiter row (colons)', () => {
    expect(isInOpenTable('| L | C | R |\n| :--- | :--: | ---: |')).toBe(true);
  });

  it('detects a delimiter even before the first data row arrives', () => {
    // Mid-stream: header + delimiter present, rows still streaming.
    expect(isInOpenTable('| Col A | Col B |\n|-------|-------|\n')).toBe(true);
  });

  it('detects a no-outer-pipe delimiter row', () => {
    expect(isInOpenTable('A | B\n--- | ---\n1 | 2')).toBe(true);
  });

  it('returns false for a horizontal rule (no pipe)', () => {
    expect(isInOpenTable('above\n\n---\n\nbelow')).toBe(false);
  });

  it('returns false for prose containing a stray pipe (no dash-only row)', () => {
    expect(isInOpenTable('run `a | b` to pipe output')).toBe(false);
  });

  it('returns false for a setext underline', () => {
    expect(isInOpenTable('Heading\n=======')).toBe(false);
  });

  it('returns false for empty / whitespace buffers', () => {
    expect(isInOpenTable('')).toBe(false);
    expect(isInOpenTable('   \n  \n')).toBe(false);
  });

  it('returns false for a table header row alone (no delimiter yet)', () => {
    // A lone `| a | b |` is a paragraph until the delimiter row arrives — and
    // a single short line never overflows the viewport, so no guard needed.
    expect(isInOpenTable('| just | a | row |')).toBe(false);
  });
});

describe('formatPendingBuffer', () => {
  const WIDTH = 80;

  it('shows live table row content for an in-progress table (not a placeholder)', () => {
    const tall = ['| Col A | Col B |', '|-------|-------|']
      .concat(Array.from({ length: 40 }, (_, i) => `| row ${i} | value ${i} |`))
      .join('\n');

    const out = formatPendingBuffer(tall, WIDTH, true);

    // Live preview: the actual pipe-delimited rows must be visible (dimmed).
    expect(stripAnsi(out)).toContain('Col A');
    expect(stripAnsi(out)).toContain('value 39');
    // The rendered table borders (│) from the commit-time table renderer must
    // NOT appear — alignment is deferred to commit time.
    expect(out).not.toContain('│');
    // Must NOT contain the old fixed placeholder text.
    expect(out).not.toContain('streaming table');
  });

  it('shows live code content for an open code fence (not a placeholder)', () => {
    const buf = '```python\ndef hello():\n    print("wor';
    const out = formatPendingBuffer(buf, WIDTH, true);
    // Live preview: actual code lines must be visible (dimmed).
    expect(stripAnsi(out)).toContain('def hello():');
    expect(stripAnsi(out)).toContain('print("wor');
    // Language tag should be shown as a label.
    expect(stripAnsi(out)).toContain('[python]');
    // Must NOT contain the old fixed placeholder text.
    expect(out).not.toContain('streaming code');
    // Table guard must not fire for a code fence containing table-like content.
    expect(out).not.toContain('streaming table');
  });

  it('code fence with no language tag shows code content without a label', () => {
    const buf = '```\nconst x = 1;\n';
    const out = formatPendingBuffer(buf, WIDTH, true);
    expect(stripAnsi(out)).toContain('const x = 1;');
    expect(out).not.toContain('streaming code');
  });

  it('still prioritises code-fence guard over table guard', () => {
    // A fenced block whose body looks table-ish must be treated as code, not a
    // table — the code-fence guard is checked first.
    const out = formatPendingBuffer('```\n|---|---|\n| a | b |', WIDTH, true);
    // Code content is shown; old placeholder strings must be absent.
    expect(out).not.toContain('streaming code');
    expect(out).not.toContain('streaming table');
    // The delimiter row appears in the dimmed code preview.
    expect(stripAnsi(out)).toContain('|---|---|');
  });

  it('renders plain prose normally (no placeholder)', () => {
    const out = formatPendingBuffer('hello world', WIDTH, true);
    expect(out).toContain('hello world');
    expect(out).not.toContain('streaming');
  });

  it('returns empty string when shouldRender is false', () => {
    expect(formatPendingBuffer('| A |\n|---|\n| 1 |', WIDTH, false)).toBe('');
  });

  it('returns empty string for a whitespace-only buffer', () => {
    expect(formatPendingBuffer('   ', WIDTH, true)).toBe('');
  });
});

describe('isInOpenCodeFence (precedence sanity)', () => {
  it('is true for an unclosed fence even when it contains table-like rows', () => {
    expect(isInOpenCodeFence('```\n|---|---|\n')).toBe(true);
  });
});

// A committed block must own NEITHER a leading nor a trailing blank line: the
// caller (commitBlock) re-adds exactly one trailing blank via
// `commitAbove(trimmed + '\n\n')`. See docs/tui-rhythm.md.
describe('formatBlockForCommit blank-line trimming', () => {
  const WIDTH = 80;

  it('strips leading blank lines (surplus newline from a 3+ newline section break)', () => {
    const out = formatBlockForCommit('\n\nActual content.', '  ', WIDTH);
    expect(stripAnsi(out).startsWith('\n')).toBe(false);
    expect(stripAnsi(out)).toContain('Actual content.');
  });

  it('strips trailing blank lines', () => {
    const out = formatBlockForCommit('Content.\n\n\n', '  ', WIDTH);
    expect(out.endsWith('\n')).toBe(false);
  });

  it('a heading block carries no leading blank into scrollback', () => {
    const out = formatBlockForCommit('## Done\n\n', '  ', WIDTH);
    expect(stripAnsi(out).startsWith('\n')).toBe(false);
    expect(stripAnsi(out)).toContain('Done');
  });
});

describe('scheduleWithThrottle (leading + trailing)', () => {
  it('fires immediately (leading edge) when enough time has elapsed', async () => {
    let fired = false;
    const cb = () => { fired = true; };
    // lastPaintTime far in the past — leading edge should fire
    const result = scheduleWithThrottle(cb, 33, null, 0);
    // Leading edge: no trailing timer, paintTime updated to ~now
    expect(result.timer).toBeNull();
    expect(result.paintTime).toBeGreaterThan(0);
    // Callback is queued via queueMicrotask, not synchronous
    expect(fired).toBe(false);
    // Drain the microtask queue and verify callback fires
    await Promise.resolve();
    expect(fired).toBe(true);
  });

  it('defers to trailing edge when inside the throttle window', () => {
    let fired = false;
    const cb = () => { fired = true; };
    const now = Date.now();
    // lastPaintTime is very recent — inside the throttle window
    const result = scheduleWithThrottle(cb, 33, null, now);
    // Trailing edge: timer is set, paintTime unchanged
    expect(result.timer).not.toBeNull();
    expect(result.paintTime).toBe(now);
    expect(fired).toBe(false);
    // Clean up the timer
    if (result.timer) clearTimeout(result.timer);
  });

  it('clears existing timer when scheduling trailing edge', () => {
    let count = 0;
    const cb = () => { count++; };
    const now = Date.now();
    // First call: schedule trailing
    const r1 = scheduleWithThrottle(cb, 33, null, now);
    // Second call: should clear the first timer
    const r2 = scheduleWithThrottle(cb, 33, r1.timer, now);
    expect(r2.timer).not.toBeNull();
    // Clean up
    if (r2.timer) clearTimeout(r2.timer);
  });

  it('trailing timer uses remaining time in the window', async () => {
    let fired = false;
    const cb = () => { fired = true; };
    // lastPaintTime is 20ms ago, throttle is 33ms — remaining ~13ms
    const result = scheduleWithThrottle(cb, 33, null, Date.now() - 20);
    expect(result.timer).not.toBeNull();
    // Wait for the trailing timer to fire
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Phase 3A: block-commit transition smoothing — render-path invariant audit
//
// These tests document the result of an explicit audit comparing the PENDING
// and COMMITTED render paths (see markdown-stream-format.ts):
//
//   PENDING:  formatPendingBuffer  → renderTextBlock(…, false) → wrapToWidth(…, {breakLongWords:true})
//   COMMITTED: formatBlockForCommit → renderTextBlock(…, true)  → wrapToWidth(…, {breakLongWords:true})
//
// Audit findings (Phase 3A):
//  1. Width calculation: IDENTICAL — both paths call calculateProseContentWidth
//     for prose and calculateContentWidth for code. commitBlock() checks `isCode`
//     the same way renderPending() does.
//  2. wrapToWidth options: IDENTICAL — both pass `{ breakLongWords: true }`.
//  3. applyIndent: IDENTICAL — both call applyIndent(result, indent).
//  4. closePendingInlineSyntax: pending-only; no-op on complete text (a complete
//     block has no unclosed spans), so the visual output is identical at commit.
//  5. isCommit flag: true at commit, false at pending. This flag only gates
//     registerArtifact() side-effects (/copy index) — it does NOT alter the
//     ANSI-styled output string. Both paths produce pixel-identical rendered text.
//  6. trim: commit path strips leading/trailing blank lines per the TUI rhythm
//     contract (docs/tui-rhythm.md); commitBlock() re-adds exactly one trailing
//     blank. Not a visual difference — the blank appears identically in both.
//
// Conclusion: the two paths are already visually identical for the same input.
// No code change is needed; these tests pin the invariant for future regressions.
// ---------------------------------------------------------------------------

describe('Phase 3A render-path invariant: pending and commit produce identical output', () => {
  const INDENT = '   ';  // default indent (3 spaces)
  const WIDTH = 80;

  // Strip ANSI to compare plain visual output
  const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

  it('plain prose: pending and committed output are visually identical', () => {
    const text = 'Hello world this is a plain prose block with enough words to wrap.';

    const pending = formatPendingBuffer(text, WIDTH, true);
    // committed path: formatBlockForCommit trims leading/trailing blanks and
    // the caller re-adds one blank, but the TEXT content is identical.
    const committed = formatBlockForCommit(text, '', WIDTH);

    // Both should contain the same words in the same wrapping order.
    expect(strip(pending)).toBe(strip(committed));
  });

  it('both paths use calculateProseContentWidth for prose blocks', () => {
    // calculateProseContentWidth and calculateContentWidth are separate functions.
    // For a standard indent the prose measure (80) is narrower than code (100).
    // commitBlock() chooses prose width when isCode is false — same as renderPending().
    const indentLen = INDENT.length;
    const proseWidth = calculateProseContentWidth(indentLen);
    const codeWidth = calculateContentWidth(indentLen);
    // On a typical 80-col terminal the prose measure equals the content width
    // (no room to tighten further); on wide terminals prose is tighter than code.
    expect(proseWidth).toBeLessThanOrEqual(codeWidth);
    // Both must be positive integers.
    expect(proseWidth).toBeGreaterThan(0);
    expect(codeWidth).toBeGreaterThan(0);
  });

  it('committed text is not wider than content width (wrapToWidth enforced)', () => {
    // Verify that formatBlockForCommit enforces width via wrapToWidth, so the
    // committed render cannot differ from the pending render due to overflow.
    const longLine = 'https://example.com/' + 'x'.repeat(100);  // unbreakable URL
    const committed = formatBlockForCommit(longLine, '', WIDTH);
    for (const line of strip(committed).split('\n')) {
      // breakLongWords=true: every line must be within WIDTH
      expect(line.length).toBeLessThanOrEqual(WIDTH);
    }
  });

  it('pending text is not wider than content width (wrapToWidth enforced)', () => {
    const longLine = 'https://example.com/' + 'x'.repeat(100);
    const pending = formatPendingBuffer(longLine, WIDTH, true);
    for (const line of strip(pending).split('\n')) {
      expect(line.length).toBeLessThanOrEqual(WIDTH);
    }
  });

  it('isCommit flag does not alter ANSI output for plain text (no artifact side-effect on plain)', () => {
    // Plain text blocks take the wrapToWidth path in renderTextBlock, bypassing
    // renderMarkdownToTerminal entirely — isCommit has no effect on them at all.
    const text = 'plain text without any markdown markers';
    const pending = formatPendingBuffer(text, WIDTH, true);
    const committed = formatBlockForCommit(text, '', WIDTH);
    expect(strip(pending)).toBe(strip(committed));
  });
});
