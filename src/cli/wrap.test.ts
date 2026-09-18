/**
 * Tests for src/cli/wrap.ts — ANSI-aware wrapping.
 */

import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { wrapToWidth } from './wrap.js';

const stripAnsi = (text: string): string => text.replace(/\x1B\[[0-9;]*m/g, '');

describe('wrapToWidth', () => {
  it('returns short text unchanged', () => {
    expect(wrapToWidth('hello', 80)).toBe('hello');
  });

  it('wraps long plain text across lines', () => {
    const s = 'one two three four five six seven eight';
    const out = wrapToWidth(s, 10);
    expect(out.split('\n').length).toBeGreaterThan(1);
    expect(out).toContain('one');
  });

  it('does not carry a boundary space onto the next line', () => {
    const text =
      'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp';

    expect(wrapToWidth(text, 24).split('\n')).toEqual([
      'aaaa bbbb cccc dddd eeee',
      'ffff gggg hhhh iiii jjjj',
      'kkkk llll mmmm nnnn oooo',
      'pppp',
    ]);
  });

  it('wraps chalk-colored strings without throwing', () => {
    const colored = chalk.red('redword') + ' ' + 'plain ' + chalk.green('greenword');
    const out = wrapToWidth(colored, 8);
    expect(out).toContain('redword');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('preserves intentional indentation after leading ANSI styles', () => {
    const text = chalk.dim('  • one two three four');
    const lines = wrapToWidth(text, 12, { breakLongWords: true }).split('\n');

    expect(stripAnsi(lines[0]!)).toBe('  • one two');
    expect(stripAnsi(lines[1]!)).toBe('three four');
  });

  it('does not throw for width 0 or Infinity', () => {
    expect(() => wrapToWidth('abc', 0)).not.toThrow();
    expect(wrapToWidth('abc', 0)).toBe('abc');
    expect(() => wrapToWidth('abc', Number.POSITIVE_INFINITY)).not.toThrow();
    expect(wrapToWidth('abc', Number.POSITIVE_INFINITY)).toBe('abc');
    expect(() => wrapToWidth('abc', Number.NaN)).not.toThrow();
    expect(wrapToWidth('abc', Number.NaN)).toBe('abc');
  });

  it('leaves an over-long unbreakable token intact by default (soft wrap)', () => {
    const url = 'https://example.com/' + 'a'.repeat(60);
    const out = wrapToWidth(url, 20);
    // Soft wrap: the single long token overflows past `width` on one line.
    expect(out).toBe(url);
    expect(out.split('\n')).toHaveLength(1);
  });

  it('breaks an over-long unbreakable token when breakLongWords is set', () => {
    const url = 'https://example.com/' + 'a'.repeat(60);
    const out = wrapToWidth(url, 20, { breakLongWords: true });
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // No physical line exceeds the width once long words are broken.
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });

  it('breakLongWords still wraps normal prose at word boundaries (no mid-word splits)', () => {
    const prose = 'one two three four five six seven eight nine ten';
    const out = wrapToWidth(prose, 12, { breakLongWords: true });
    // Every whole word survives un-split — only over-long tokens are broken.
    for (const word of prose.split(' ')) {
      expect(out).toContain(word);
    }
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('does not corrupt genuine U+E000 bytes when all 256 PUA slots are occupied (indentMarker fallback path)', () => {
    // Build a line that uses all 256 PUA code points (U+E000–U+E0FF) so that
    // the indentMarker search finds no free candidate and falls back to undefined.
    // The line must also be short enough that wrapAnsi leaves it unchanged.
    const allPua = Array.from({ length: 256 }, (_, i) => String.fromCodePoint(0xe000 + i)).join('');
    // The line starts with a leading space (so the indent-protect branch runs)
    // followed by the block of all PUA chars. We use a narrow enough line that
    // the content itself doesn't wrap (width = 512 covers everything).
    const line = ' ' + allPua;
    const out = wrapToWidth(line, 512);
    // The genuine U+E000 byte must survive untouched — it must NOT have been
    // replaced with a space by the now-skipped `.replaceAll(indentMarker ?? '\uE000', ' ')`.
    expect(out).toContain('\uE000');
    // The overall content is preserved (minus any leading-space trim wrap-ansi may apply).
    expect(out).toContain(allPua);
  });
});

// ---------------------------------------------------------------------------
// Phase 3B: cell-width correctness audit — CJK and emoji handling
//
// Audit finding: wrap-ansi v10 (our dependency) internally imports string-width
// v8 for ALL column measurements. string-width correctly reports 2 display cells
// for CJK Unified Ideographs and most emoji, so wrapToWidth() inherits correct
// cell-width handling without any additional code.
//
// Evidence:
//   node_modules/wrap-ansi/index.js line 1: import stringWidth from 'string-width'
//   node_modules/wrap-ansi/package.json dependencies: { "string-width": "^8.2.0" }
//   package.json: "string-width": "^8.2.0" (also a direct dep in this project)
//
// Wrap-mode semantics for CJK (documented here for future maintainers):
//
//   SOFT WRAP (breakLongWords: false, the default):
//     wrap-ansi v10 uses word-wrap mode — it splits at spaces/word-boundaries.
//     A contiguous run of CJK without spaces is treated as ONE "word" and is
//     not split, exactly like a long ASCII token without spaces (e.g. a URL).
//     When CJK characters ARE separated by spaces, wrap-ansi measures their
//     cell width correctly (via string-width) and wraps at the right boundary.
//
//   HARD WRAP (breakLongWords: true):
//     wrap-ansi v10 uses hard mode — it forces a break after every cell-width
//     boundary regardless of word boundaries. CJK strings are broken at exact
//     2-cell boundaries. This is the correct mode for forcing CJK text to fit.
//
// These tests pin the invariant so a future wrap-ansi upgrade cannot silently
// regress cell-width measurement.
// ---------------------------------------------------------------------------

describe('wrapToWidth — CJK and emoji cell-width (Phase 3B audit)', () => {
  it('soft-wrap: CJK with spaces wraps at correct cell boundaries', () => {
    // "一 二 三 四 五 六" — each char is 2 cells, space is 1 cell.
    // At width=6: "一 二" = 5 cells, "三 四" = 5 cells, "五 六" = 5 cells (all fit).
    const cjkSpaced = '一 二 三 四 五 六';
    const lines = wrapToWidth(cjkSpaced, 6).split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // No line must exceed 6 display cells; each char × 2 + spaces
    for (const line of lines) {
      // Measure via char count (2 per CJK, 1 per space)
      const cells = [...line].reduce((sum, ch) => sum + (/\s/.test(ch) ? 1 : 2), 0);
      expect(cells).toBeLessThanOrEqual(6);
    }
  });

  it('soft-wrap: contiguous CJK without spaces is treated as one word (no split)', () => {
    // This mirrors the behaviour of a long ASCII token with no spaces — soft-wrap
    // leaves it intact. The fix is to use breakLongWords:true when hard splitting
    // is needed (e.g. the committed-band path already does this).
    const cjk = '一二三四五六';  // 6 × 2 = 12 cells — one "word" in soft-wrap
    const out = wrapToWidth(cjk, 10);  // 10 < 12, but no word boundary
    expect(out.split('\n')).toHaveLength(1);  // stays on one line, same as a long URL
  });

  it('breakLongWords: CJK without spaces is split at exact cell boundaries', () => {
    // At width=10: 5 CJK chars (10 cells) fit on line 1; 1 char on line 2.
    const cjk = '一二三四五六';  // 12 cells
    const lines = wrapToWidth(cjk, 10, { breakLongWords: true }).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // All original characters must survive (no loss)
    expect(lines.join('')).toBe(cjk);
    // No line may exceed 10 cells (2 cells per CJK char)
    for (const line of lines) {
      expect([...line].length * 2).toBeLessThanOrEqual(10);
    }
  });

  it('breakLongWords: 10 CJK chars wrapped at width 8 fit within 4 chars per line', () => {
    // 4 CJK chars = 8 cells = exactly width; 10 chars → ceil(10/4) = 3 lines.
    const cjk = '一二三四五六七八九十';  // 20 cells
    const lines = wrapToWidth(cjk, 8, { breakLongWords: true }).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const rejoined = lines.join('');
    expect(rejoined).toBe(cjk);
    for (const line of lines) {
      expect([...line].length * 2).toBeLessThanOrEqual(8);
    }
  });

  it('does not wrap CJK text that already fits (no false wrap)', () => {
    // 4 CJK chars = 8 cells; at width=10 they fit — no wrap regardless of mode.
    const cjk = '一二三四';  // 8 cells
    expect(wrapToWidth(cjk, 10).split('\n')).toHaveLength(1);
    expect(wrapToWidth(cjk, 10, { breakLongWords: true }).split('\n')).toHaveLength(1);
  });

  it('soft-wrap: mixed ASCII+CJK wraps at correct cell boundary when spaces present', () => {
    // "Hi 一二三 四五六" — "Hi" "一二三" "四五六" are the three words.
    // "Hi " = 3 cells, "一二三" = 6 cells → 9 cells on line 1 ≤ 10.
    // " 四五六" = 7 cells → would push to 16 total, so 四五六 goes to line 2.
    const mixed = 'Hi 一二三 四五六';
    const lines = wrapToWidth(mixed, 10).split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // The ASCII and all CJK characters must survive.
    const text = lines.join(' ').replace(/\s+/g, '');
    expect(text).toBe(mixed.replace(/\s+/g, ''));
  });
});
