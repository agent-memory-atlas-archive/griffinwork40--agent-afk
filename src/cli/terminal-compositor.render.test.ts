/**
 * Unit tests for terminal-compositor.render free functions.
 *
 * These tests exercise the pure string-producer functions directly, without
 * spinning up a full TerminalCompositor. The minimal RenderHost mock only
 * supplies the fields each function reads.
 */

import { describe, it, expect } from 'vitest';
import { renderDropdownRows, renderInputLine } from './terminal-compositor.render.js';
import type { RenderHost } from './terminal-compositor.render.js';
import { displayWidth, stripAnsi } from './display.js';
import type { AutocompleteState } from './input/autocomplete-state.js';
import type { Candidate } from './input/types.js';
import { palette } from './palette.js';

// ---------------------------------------------------------------------------
// Minimal RenderHost factory — only the fields renderDropdownRows reads.
// ---------------------------------------------------------------------------
function makeHost(cols: number, candidates: Candidate[]): RenderHost {
  const ac: AutocompleteState = {
    dropdownOpen: true,
    candidates,
    selectedIndex: 0,
    viewportStart: 0,
    suppressedSignature: null,
    trigger: null,
    reset() { /* no-op for tests */ },
  };
  return {
    queued: false,
    pendingSubmissions: [],
    input: { buffer: '', cursor: 0 },
    activeGhost: null,
    autocompleteState: ac,
    promptTextFn: () => '> ',
    stdout: { columns: cols } as NodeJS.WriteStream,
  };
}

// ---------------------------------------------------------------------------
// renderDropdownRows — wide-char soft-wrap height fix
// ---------------------------------------------------------------------------

describe('renderDropdownRows — wide-char soft-wrap counting', () => {
  it('does not produce extra blank placeholder rows for ASCII candidates', () => {
    // A short ASCII candidate fits in one display row — no soft-wrap placeholder.
    const host = makeHost(80, [{ value: '/mint', summary: 'Run mint' }]);
    const rows = renderDropdownRows(host);
    // One candidate → one formatted row, no blank placeholders.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain('/mint');
  });

  it('measures wide-char (CJK) candidates in display columns, not UTF-16 length', () => {
    // '東京都市' has .length === 4 but display width === 8 (each char is 2
    // terminal columns). The fix measures the rendered row with displayWidth
    // (matching `cols`, also display columns) instead of .length.
    //
    // A test that distinguishes displayWidth from a naive .length purely via the
    // soft-wrap COUNT is not constructable at this layer: formatDropdownRow
    // truncates every row to `min(cols-4, 60)` display columns — always < cols —
    // so softWraps is 0 for any well-formed CJK row no matter which width measure
    // the source uses. We therefore pin the observable contract instead: wide
    // content that fits the budget produces exactly one row with no phantom
    // soft-wrap placeholders, and the rendered row's display width stays within
    // the terminal (i.e. it was truncated/measured in display columns).
    const cols = 41; // smallest width that passes the `cols > 40` guard
    const host = makeHost(cols, [{ value: '東京都市', summary: '東京の候補' }]);
    const rows = renderDropdownRows(host);
    const blanks = rows.filter((r) => r === '');
    const nonBlank = rows.filter((r) => r !== '');
    expect(nonBlank).toHaveLength(1);
    expect(blanks).toHaveLength(0);
    expect(displayWidth(stripAnsi(nonBlank[0]!))).toBeLessThanOrEqual(cols);
  });

  it('emits one row per fitting candidate with the value preserved and no phantom blanks', () => {
    // formatDropdownRow truncates each row to min(cols-4, 60) display columns,
    // so a normal ASCII candidate always fits in one visual row. Assert the real
    // structural contract (the prior version asserted `blanks.length >= 0` and
    // `toBeTruthy()` on already-non-empty rows — both vacuously true):
    //   - exactly one rendered (non-blank) row,
    //   - zero blank soft-wrap placeholders,
    //   - the rendered row carries the candidate value.
    const host = makeHost(50, [{ value: '/test-cmd', summary: 'Summary text here' }]);
    const rows = renderDropdownRows(host);
    const blanks = rows.filter((r) => r === '');
    const nonBlanks = rows.filter((r) => r !== '');
    expect(nonBlanks).toHaveLength(1);
    expect(blanks).toHaveLength(0);
    expect(nonBlanks.every((r) => stripAnsi(r).includes('/test-cmd'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderInputLine — caret blink phase (▏ thin-bar pulse)
// ---------------------------------------------------------------------------

const THIN_BAR = '\u258f'; // ▏ LEFT ONE EIGHTH BLOCK

function makeInputHost(opts: {
  buffer: string;
  cursor: number;
  caretVisible?: boolean;
  activeGhost?: string | null;
  promptTextFn?: (buffer: string) => string;
}): RenderHost {
  return {
    queued: false,
    pendingSubmissions: [],
    input: { buffer: opts.buffer, cursor: opts.cursor },
    ...(opts.caretVisible !== undefined ? { caretVisible: opts.caretVisible } : {}),
    activeGhost: opts.activeGhost ?? null,
    promptTextFn: opts.promptTextFn ?? (() => '> '),
    stdout: { columns: 80 } as NodeJS.WriteStream,
  };
}

describe('renderInputLine — shell mode', () => {
  it.each([
    ['!', 'command'],
    ['!git status', '  (shell)'],
    ['!&pnpm test', '  (shell: background)'],
    ['!&', '  (shell: background)'],
  ])('renders the fixed ghost hint for %s', (buffer, hint) => {
    const line = renderInputLine(makeInputHost({
      buffer,
      cursor: buffer.length,
      activeGhost: buffer + ' competing suggestion',
      promptTextFn: (liveBuffer) => liveBuffer.startsWith('!') ? '$ ' : '> ',
    }));
    expect(stripAnsi(line)).toBe(`$ ${buffer}${THIN_BAR}${hint}`);
  });

  it('renders shell ghost hints in palette.meta, not palette.dim', () => {
    const previousLevel = palette.meta.level;
    palette.meta.level = 3;
    try {
      const line = renderInputLine(makeInputHost({
        buffer: '!git status',
        cursor: '!git status'.length,
        activeGhost: '!git status --verbose',
        promptTextFn: () => '$ ',
      }));
      // Shell ghost hints use palette.meta (dim gray) — not palette.dim —
      // to read as a secondary hint distinct from the shell input tone.
      expect(line).toContain(palette.meta('  (shell)'));
      expect(line).not.toContain(palette.dim('  (shell)'));
    } finally {
      palette.meta.level = previousLevel;
    }
  });

  it('renders non-shell ghost suggestions in palette.dim', () => {
    const previousLevel = palette.dim.level;
    palette.dim.level = 3;
    try {
      const line = renderInputLine(makeInputHost({
        buffer: 'hello',
        cursor: 5,
        activeGhost: 'hello world',
      }));
      // Non-shell (history/LLM) ghosts use palette.dim — the pre-existing tone.
      expect(line).toContain(palette.dim(' world'));
    } finally {
      palette.dim.level = previousLevel;
    }
  });

  it('colors both sides of a mid-buffer caret with the shell tone', () => {
    const previousLevel = palette.shell.level;
    palette.shell.level = 3;
    try {
      const line = renderInputLine(makeInputHost({ buffer: '!echo hi', cursor: 3 }));
      expect(line).toContain(palette.shell('!ec'));
      expect(line).toContain(palette.shell('o hi'));
    } finally {
      palette.shell.level = previousLevel;
    }
  });
});

describe('renderInputLine — caret blink', () => {
  it('paints the ▏ thin-bar caret in the visible phase (end-of-buffer)', () => {
    const line = renderInputLine(makeInputHost({ buffer: '', cursor: 0, caretVisible: true }));
    expect(line).toContain(THIN_BAR);
  });

  it('blanks the caret in the off phase, preserving the one-cell width (end-of-buffer)', () => {
    const on = renderInputLine(makeInputHost({ buffer: '', cursor: 0, caretVisible: true }));
    const off = renderInputLine(makeInputHost({ buffer: '', cursor: 0, caretVisible: false }));
    // Off-phase drops the thin bar entirely…
    expect(off).not.toContain(THIN_BAR);
    // …and replaces it with a single blank cell — same display width as the
    // visible phase so the line never shifts as the caret pulses.
    expect(displayWidth(stripAnsi(off))).toBe(displayWidth(stripAnsi(on)));
    expect(stripAnsi(off)).toBe('>  '); // prompt '> ' + one blank caret cell
  });

  it('defaults to a solid caret when caretVisible is absent (non-blinking host)', () => {
    const line = renderInputLine(makeInputHost({ buffer: '', cursor: 0 }));
    expect(line).toContain(THIN_BAR);
  });

  it('off-phase mid-buffer reveals the underlying char un-inverted (block-cursor off)', async () => {
    // Cursor sits on the 'b' of 'abc'. The visible phase inverse-videos that
    // cell (SGR `\x1b[7m`); the off phase shows the bare character. Force chalk
    // colour so the inverse SGR is observable.
    const chalkModule = await import('chalk');
    const priorLevel = chalkModule.default.level;
    chalkModule.default.level = 1;
    try {
      const on = renderInputLine(makeInputHost({ buffer: 'abc', cursor: 1, caretVisible: true }));
      const off = renderInputLine(makeInputHost({ buffer: 'abc', cursor: 1, caretVisible: false }));
      expect(on).toContain('\x1b[7m'); // inverse-video open in the visible phase
      expect(off).not.toContain('\x1b[7m'); // off phase is un-inverted
      // Same single-cell width in both phases (no inverse ≠ width change).
      expect(displayWidth(stripAnsi(on))).toBe(displayWidth(stripAnsi(off)));
      expect(stripAnsi(off)).toContain('abc');
    } finally {
      chalkModule.default.level = priorLevel;
    }
  });
});
