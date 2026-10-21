/**
 * BufferingWriter — a WriterSink that captures all output for HTTP responses.
 *
 * Slash-command handlers write through a `Writer` interface. On the web
 * surface we cannot print to a terminal; instead we buffer every write and
 * return the accumulated output as a `CommandOutputBlock` in the JSON
 * response.
 *
 * Usage:
 *   const bw = new BufferingWriter();
 *   const ctx = createWebSlashContext(ref, stats, bw, cwd);
 *   await cmd.handler(ctx, args);
 *   const block = bw.toOutputBlock(); // { ansi, text }
 */

import { stripVTControlCharacters } from 'node:util';
import { createConsoleWriter } from '../cli/slash/writer.js';
import type { WriterSink } from '../cli/slash/writer.js';
import type { Writer } from '../cli/slash/types.js';
import type { CommandOutputBlock } from './shared/command-wire.js';

export class BufferingWriter implements WriterSink {
  private readonly chunks: string[] = [];

  /** WriterSink.fn — called for every line() / success() / info() / warn() / error() write. */
  fn(line: string): void {
    this.chunks.push(line + '\n');
  }

  /** WriterSink.rawFn — called for every raw() write (no trailing newline). */
  rawFn(text: string): void {
    this.chunks.push(text);
  }

  /** All captured chunks in write order. */
  getChunks(): string[] {
    return [...this.chunks];
  }

  /** Wrap this sink in the full Writer interface via createConsoleWriter. */
  asWriterInterface(): Writer {
    return createConsoleWriter(this);
  }

  /**
   * Produce a CommandOutputBlock from the accumulated output.
   * `ansi` is the raw ANSI-escaped output; `text` has all VT control
   * characters stripped (safe for plain-text display).
   */
  toOutputBlock(): CommandOutputBlock {
    const ansi = this.chunks.join('');
    return {
      ansi,
      text: stripVTControlCharacters(ansi),
    };
  }
}
