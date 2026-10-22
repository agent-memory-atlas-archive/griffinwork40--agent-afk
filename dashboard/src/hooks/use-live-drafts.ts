/**
 * Live draft text for the turn in progress.
 *
 * Invariant: drafts are a render-only overlay. They are keyed by `part:seg`
 * (numbered by the server's SegmentTracker, the same numbering the durable
 * ledger records carry) and always render AFTER every durable item. When the
 * durable `assistant`/`thinking` record with the same seg arrives, `claim`
 * hands its item id to the durable item and drops the draft, so React keeps
 * the same DOM node (no remount, no flicker). Rules:
 *   - `live_reset` (reconnect / ledger reset) clears drafts; the server's next
 *     `live_snapshot` rebuilds the open segments;
 *   - a `live_delta` whose offset does not continue the draft is a gap: the
 *     draft is marked stale and ignores deltas until the next snapshot;
 *   - a durable `done`/`error` (`settle`) drops the ended turn's drafts (those
 *     sealed or ended), never a next turn's streaming draft;
 *   - live frames for a seg already claimed by a durable record are ignored
 *     until the live turn ends (guards a durable-before-live race);
 *   - `live_end` aborted keeps unmatched drafts as "interrupted" items.
 * Updates are coalesced to one React state change per animation frame.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TranscriptItem } from '@/lib/ledger-adapter';
import type { LiveClientEvent, LivePart } from '@/types/live-wire';

export type LiveState = 'streaming' | 'sealed' | 'interrupted';

interface Draft {
  id: string;
  seg: number;
  part: LivePart;
  text: string;
  state: LiveState;
  stale: boolean;
}

/** A transcript item carrying its live draft state (absent on durable items). */
export type LiveTranscriptItem = TranscriptItem & { live?: LiveState };

export function liveStateOf(item: TranscriptItem): LiveState | undefined {
  return (item as LiveTranscriptItem).live;
}

let draftCounter = 0;
const key = (part: LivePart, seg: number): string => `${part}:${seg}`;

function toItem(d: Draft): LiveTranscriptItem {
  return d.part === 'text'
    ? { kind: 'assistant', id: d.id, text: d.text, live: d.state }
    : { kind: 'thinking', id: d.id, text: d.text, live: d.state };
}

const schedule = (cb: () => void): (() => void) => {
  if (typeof requestAnimationFrame === 'function') {
    const h = requestAnimationFrame(cb);
    return () => cancelAnimationFrame(h);
  }
  const t = setTimeout(cb, 16);
  return () => clearTimeout(t);
};

export interface UseLiveDraftsResult {
  drafts: LiveTranscriptItem[];
  onLive: (event: LiveClientEvent) => void;
  /** Durable record for `part:seg` arrived: returns the draft id to reuse. */
  claim: (part: LivePart, seg: number) => string | undefined;
  /** Durable turn end: drop all drafts. */
  settle: () => void;
  /** Session/generation change: drop everything. */
  clearAll: () => void;
}

export function useLiveDrafts(): UseLiveDraftsResult {
  const draftsRef = useRef(new Map<string, Draft>());
  const interruptedRef = useRef(new Map<string, Draft>());
  const claimedRef = useRef(new Set<string>());
  const [drafts, setDrafts] = useState<LiveTranscriptItem[]>([]);
  const cancelRef = useRef<(() => void) | undefined>(undefined);

  const publishNow = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = undefined;
    const all = [...interruptedRef.current.values(), ...[...draftsRef.current.values()].sort((a, b) => a.seg - b.seg)];
    setDrafts(all.filter((d) => d.text.length > 0).map(toItem));
  }, []);
  const publish = useCallback(() => {
    if (cancelRef.current) return;
    cancelRef.current = schedule(() => { cancelRef.current = undefined; publishNow(); });
  }, [publishNow]);
  useEffect(() => () => cancelRef.current?.(), []);

  const onLive = useCallback((event: LiveClientEvent) => {
    const map = draftsRef.current;
    switch (event.type) {
      case 'live_reset':
        map.clear();
        break;
      case 'live_snapshot': {
        const k = key(event.part, event.seg);
        if (claimedRef.current.has(k)) return;
        const prev = map.get(k);
        map.set(k, { id: prev?.id ?? `live-${++draftCounter}`, seg: event.seg, part: event.part,
          text: event.text, state: 'streaming', stale: false });
        break;
      }
      case 'live_delta': {
        const k = key(event.part, event.seg);
        if (claimedRef.current.has(k)) return;
        let d = map.get(k);
        if (!d && event.offset === 0) {
          d = { id: `live-${++draftCounter}`, seg: event.seg, part: event.part, text: '', state: 'streaming', stale: false };
          map.set(k, d);
        }
        if (!d || d.stale) return;
        const end = event.offset + event.text.length;
        if (event.offset > d.text.length) { d.stale = true; return; }
        if (end <= d.text.length) return; // duplicate
        d.text += event.text.slice(d.text.length - event.offset);
        break;
      }
      case 'live_seal': {
        const d = map.get(key(event.part, event.seg));
        if (d) d.state = 'sealed';
        break;
      }
      case 'live_end':
        claimedRef.current.clear();
        if (event.reason === 'aborted') {
          for (const [k, d] of map) interruptedRef.current.set(k, { ...d, state: 'interrupted' });
          map.clear();
        } else {
          // done/error: drafts stay until their durable records claim them.
          for (const d of map.values()) d.state = 'sealed';
        }
        break;
    }
    publish();
  }, [publish]);

  const claim = useCallback((part: LivePart, seg: number): string | undefined => {
    const k = key(part, seg);
    // An interrupted turn's late durable flush matches its own draft first.
    const source = interruptedRef.current.has(k) ? interruptedRef.current : draftsRef.current;
    const d = source.get(k);
    if (!d) return undefined;
    source.delete(k);
    if (source === draftsRef.current) claimedRef.current.add(k);
    publishNow();
    return d.id;
  }, [publishNow]);

  const settle = useCallback(() => {
    let changed = false;
    for (const [k, d] of draftsRef.current) {
      if (d.state === 'sealed') { draftsRef.current.delete(k); changed = true; }
    }
    if (changed) publishNow();
  }, [publishNow]);

  const clearAll = useCallback(() => {
    draftsRef.current.clear();
    claimedRef.current.clear();
    interruptedRef.current.clear();
    publishNow();
  }, [publishNow]);

  return { drafts, onLive, claim, settle, clearAll };
}
