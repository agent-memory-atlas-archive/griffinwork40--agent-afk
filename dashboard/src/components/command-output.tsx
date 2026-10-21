/**
 * Renders a command-output transcript item.
 *
 * Command-output items are CLIENT-LOCAL — they are never persisted to the
 * session journal or SSE stream. They live only in the React tree for the
 * duration of the browser session (A7).
 *
 * Each item contains one or more `CommandOutputBlock` entries from the
 * `POST /api/sessions/:id/commands` response. Blocks are rendered via the
 * block-renderer registry; unknown kinds fall back to the ANSI text renderer.
 */

import type { ReactElement } from 'react';
import { getBlockRenderer } from '@/lib/block-renderer-registry';
import type { CommandOutputBlock } from '@/types/command-wire';
import { cn } from '@/lib/utils';

interface CommandOutputProps {
  /** The input that triggered this command (e.g. "/help"). */
  input: string;
  /** Output blocks from the command handler. */
  blocks: CommandOutputBlock[];
}

export function CommandOutput({ input, blocks }: CommandOutputProps): ReactElement {
  return (
    <div className={cn('rounded-lg border border-border/50 bg-muted/30 px-3 py-2 text-sm font-mono')}>
      {/* Command echo */}
      <div className="text-muted-foreground text-xs mb-1.5 select-none">
        <span className="text-primary/70">❯</span>{' '}
        <span>{input}</span>
      </div>
      {/* Output blocks */}
      <div className="flex flex-col gap-0.5 whitespace-pre-wrap break-words leading-snug">
        {blocks.map((block, i) => {
          const renderer = getBlockRenderer('text'); // Stage 0: all blocks are text
          try {
            return <span key={i}>{renderer(block)}</span>;
          } catch {
            return <span key={i}>{block.text}</span>;
          }
        })}
      </div>
    </div>
  );
}
