import { useMemo, useCallback } from 'react';
import { ThinkingPanel } from './thinking-panel';
import { ToolCallCard } from './tool-call-card';
import { SubagentTree } from './subagent-card';
import { SessionMeter } from './session-meter';
import { buildTree } from '@/hooks/use-subagent-tree';
import { SpineTranscript, useSpineSlots } from './transcript-spine';
import {
  UserMessage,
  AssistantRow,
  ErrorItem,
  NoticeItem,
  StoppedItem,
  BgJobItem,
} from './message-row';
import type { TranscriptItem } from '@/lib/ledger-adapter';
import type { ThinkingUiMode } from '@/types/command-wire';
import type { SessionTotals } from './session-meter';
import { TranscriptSessionContext } from '@/hooks/use-full-tool-result';
import { liveStateOf } from '@/hooks/use-live-drafts';

interface TranscriptViewProps {
  items: TranscriptItem[];
  /** Rendering preference only: the original items remain intact for re-enabling. */
  thinkingUi?: ThinkingUiMode;
  totals?: SessionTotals;
  /** When true, render execution blocks as topology spine trees. */
  spineMode?: boolean;
  /** Turn in progress (live drafts carry their own streaming state). */
  turnActive?: boolean;
  /** Session being rendered; enables lazy-loading full tool results. */
  sessionId?: string;
  /** Suppress the "No transcript items yet." placeholder (command outputs fill the view). */
  hideEmptyState?: boolean;
  /** Called to retry the last turn (rewind + resend). */
  onRetry?: () => void;
  /** Called to edit-and-resend a user message. */
  onEdit?: (text: string) => void;
  /** Whether a turn is currently running (disables retry/edit buttons). */
  isBusy?: boolean;
}

// ---------------------------------------------------------------------------
// Legacy flat grouping (subagent-only groups)
// ---------------------------------------------------------------------------

type Slot =
  | { kind: 'item'; item: TranscriptItem }
  | { kind: 'subagent-group'; items: Extract<TranscriptItem, { kind: 'subagent' }>[]; id: string };

export function groupItems(items: TranscriptItem[]): Slot[] {
  const slots: Slot[] = [];
  let i = 0;

  while (i < items.length) {
    const item = items[i];
    if (item === undefined) { i++; continue; }

    if (item.kind !== 'subagent') {
      slots.push({ kind: 'item', item });
      i++;
      continue;
    }

    const subagentRun: Extract<TranscriptItem, { kind: 'subagent' }>[] = [];
    while (i < items.length) {
      const cur = items[i];
      if (cur === undefined || cur.kind !== 'subagent') break;
      subagentRun.push(cur as Extract<TranscriptItem, { kind: 'subagent' }>);
      i++;
    }

    slots.push({ kind: 'subagent-group', items: subagentRun, id: subagentRun[0]!.id });
  }

  return slots;
}

// ---------------------------------------------------------------------------
// Shared item renderer (text items only in spine mode, all in flat mode)
// ---------------------------------------------------------------------------

interface RenderItemOpts {
  isStreaming?: boolean;
  onRetry?: () => void;
  onEdit?: (text: string) => void;
  isBusy?: boolean;
}

export function renderNonSubagentItem(item: TranscriptItem, isStreamingOrOpts: boolean | RenderItemOpts = false): React.ReactNode {
  const isStreaming = typeof isStreamingOrOpts === 'boolean' ? isStreamingOrOpts : (isStreamingOrOpts.isStreaming ?? false);
  const opts: RenderItemOpts = typeof isStreamingOrOpts === 'object' ? isStreamingOrOpts : {};
  switch (item.kind) {
    case 'user':      return <UserMessage text={item.text} ts={item.ts} onEdit={opts.onEdit} isBusy={opts.isBusy} />;
    case 'assistant': return <AssistantRow text={item.text} ts={item.ts} isStreaming={isStreaming} onRetry={opts.onRetry} isBusy={opts.isBusy} />;
    case 'thinking':  return <ThinkingPanel text={item.text} isStreaming={isStreaming} />;
    case 'tool':      return <ToolCallCard {...item} />;
    case 'error':     return <ErrorItem message={item.message} />;
    case 'notice':    return <NoticeItem text={item.text} />;
    case 'stopped':   return <StoppedItem text={item.text} onRetry={opts.onRetry} isBusy={opts.isBusy} />;
    case 'bg_job':    return <BgJobItem item={item} />;
    case 'subagent':  return null;
  }
}

function renderTextItem(item: TranscriptItem, isStreamingOrOpts: boolean | RenderItemOpts = false): React.ReactNode {
  const isStreaming = typeof isStreamingOrOpts === 'boolean' ? isStreamingOrOpts : (isStreamingOrOpts.isStreaming ?? false);
  const opts: RenderItemOpts = typeof isStreamingOrOpts === 'object' ? isStreamingOrOpts : {};
  switch (item.kind) {
    case 'user':      return <UserMessage text={item.text} ts={item.ts} onEdit={opts.onEdit} isBusy={opts.isBusy} />;
    case 'assistant': return <AssistantRow text={item.text} ts={item.ts} isStreaming={isStreaming} onRetry={opts.onRetry} isBusy={opts.isBusy} />;
    case 'thinking':  return <ThinkingPanel text={item.text} isStreaming={isStreaming} />;
    case 'error':     return <ErrorItem message={item.message} />;
    case 'notice':    return <NoticeItem text={item.text} />;
    case 'stopped':   return <StoppedItem text={item.text} onRetry={opts.onRetry} isBusy={opts.isBusy} />;
    case 'bg_job':    return <BgJobItem item={item} />;
    default:          return null;
  }
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

/** Root transcript container. Maps TranscriptItem[] to per-kind components. */
export function TranscriptView({ sessionId, ...rest }: TranscriptViewProps) {
  return (
    <TranscriptSessionContext.Provider value={sessionId ?? null}>
      <TranscriptBody {...rest} />
    </TranscriptSessionContext.Provider>
  );
}

function TranscriptBody({ items, totals, thinkingUi = 'live', spineMode = true, turnActive = false, hideEmptyState = false, onRetry, onEdit, isBusy }: Omit<TranscriptViewProps, 'sessionId'>) {
  // Filter only the render projection, before either grouping path. Never mutate
  // the ledger-backed array: toggling back on restores old and new thinking.
  const visibleItems = useMemo(() => thinkingUi === 'off'
    ? items.filter((item) => item.kind !== 'thinking') : items, [items, thinkingUi]);
  const flatSlots = useMemo(() => groupItems(visibleItems), [visibleItems]);
  const spineSlots = useSpineSlots(visibleItems);

  const renderSpineTextItem = useCallback(
    (item: TranscriptItem, idx: number) => {
      const isTurnStart = item.kind === 'user' && idx > 0;
      const streaming = liveStateOf(item) === 'streaming';
      return (
        <div key={item.id} className="[content-visibility:auto] [contain-intrinsic-size:auto_160px]" {...(liveStateOf(item) ? { 'data-live': liveStateOf(item) } : {})}>
          {isTurnStart && (
            <div className="my-6 border-t border-border/40" aria-hidden="true" />
          )}
          <div className="py-2 px-1">{renderTextItem(item, { isStreaming: streaming, onRetry, onEdit, isBusy })}</div>
        </div>
      );
    },
    [onRetry, onEdit, isBusy],
  );

  return (
    <div role="log" aria-label="Conversation" aria-live="polite" aria-relevant="additions text" aria-busy={turnActive} className="flex flex-col gap-0 max-w-4xl mx-auto w-full [&_button:focus-visible]:outline-2 [&_button:focus-visible]:outline-ring [&_a:focus-visible]:outline-2 [&_a:focus-visible]:outline-ring">
      {totals && (
        <SessionMeter
          totals={totals}
          className="sticky top-0 z-10 mb-4 rounded-md border border-border bg-card px-3 py-1.5"
        />
      )}
      {items.length === 0 && hideEmptyState ? null : items.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No transcript items yet.
        </p>
      ) : spineMode ? (
        <SpineTranscript slots={spineSlots} renderTextItem={renderSpineTextItem} />
      ) : (
        flatSlots.map((slot, idx) => {
          if (slot.kind === 'item') {
            const { item } = slot;
            const isTurnStart = item.kind === 'user' && idx > 0;
            const streaming = liveStateOf(item) === 'streaming';
            return (
              <div key={item.id} className="[content-visibility:auto] [contain-intrinsic-size:auto_160px]" {...(liveStateOf(item) ? { 'data-live': liveStateOf(item) } : {})}>
                {isTurnStart && (
                  <div className="my-6 border-t border-border/40" aria-hidden="true" />
                )}
                <div className="py-2 px-1">
                  {renderNonSubagentItem(item, { isStreaming: streaming, onRetry, onEdit, isBusy })}
                </div>
              </div>
            );
          }
          const roots = buildTree(slot.items);
          return (
            <div key={slot.id} className="py-2 px-1 [content-visibility:auto] [contain-intrinsic-size:auto_100px]">
              <SubagentTree roots={roots} />
            </div>
          );
        })
      )}
    </div>
  );
}
