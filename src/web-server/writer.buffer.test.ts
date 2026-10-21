/**
 * Tests for BufferingWriter.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { stripVTControlCharacters } from 'node:util';

// Mock writer.ts to avoid palette / bounded-line deps
let mockCreateConsoleWriter: ReturnType<typeof vi.fn>;
vi.mock('../cli/slash/writer.js', () => ({
  createConsoleWriter: (...args: unknown[]) => mockCreateConsoleWriter(...args),
}));

import { BufferingWriter } from './writer.buffer.js';

const FAKE_WRITER = { line: vi.fn(), raw: vi.fn(), success: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  mockCreateConsoleWriter = vi.fn().mockReturnValue(FAKE_WRITER);
  vi.clearAllMocks();
});

describe('BufferingWriter', () => {
  it('captures fn() calls with newline appended', () => {
    const bw = new BufferingWriter();
    bw.fn('hello');
    bw.fn('world');
    expect(bw.getChunks()).toEqual(['hello\n', 'world\n']);
  });

  it('captures rawFn() calls without appending newline', () => {
    const bw = new BufferingWriter();
    bw.rawFn('raw text');
    expect(bw.getChunks()).toEqual(['raw text']);
  });

  it('captures mixed fn and rawFn calls in order', () => {
    const bw = new BufferingWriter();
    bw.fn('line1');
    bw.rawFn('raw');
    bw.fn('line2');
    expect(bw.getChunks()).toEqual(['line1\n', 'raw', 'line2\n']);
  });

  it('getChunks returns a copy (not the internal array)', () => {
    const bw = new BufferingWriter();
    bw.fn('x');
    const chunks = bw.getChunks();
    chunks.push('injected');
    expect(bw.getChunks()).toHaveLength(1);
  });

  it('asWriterInterface passes this as sink to createConsoleWriter', () => {
    const bw = new BufferingWriter();
    const w = bw.asWriterInterface();
    expect(mockCreateConsoleWriter).toHaveBeenCalledWith(bw);
    expect(w).toBe(FAKE_WRITER);
  });

  it('toOutputBlock returns ansi = joined chunks', () => {
    const bw = new BufferingWriter();
    bw.fn('hello');
    bw.rawFn(' world');
    const block = bw.toOutputBlock();
    expect(block.ansi).toBe('hello\n world');
  });

  it('toOutputBlock text = stripVTControlCharacters(ansi)', () => {
    const bw = new BufferingWriter();
    const ansiStr = '\x1b[1mbold\x1b[0m normal';
    bw.rawFn(ansiStr);
    const block = bw.toOutputBlock();
    expect(block.text).toBe(stripVTControlCharacters(ansiStr));
    expect(block.text).toBe('bold normal');
  });

  it('toOutputBlock with empty buffer returns empty strings', () => {
    const bw = new BufferingWriter();
    const block = bw.toOutputBlock();
    expect(block.ansi).toBe('');
    expect(block.text).toBe('');
  });
});
