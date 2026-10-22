import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useTranscript } from './use-transcript';
import { TranscriptView } from '@/components/transcript-view';
import { fenceSafeLength } from '@/components/streaming-text';

vi.mock('@/lib/api', () => ({ getToken: () => 'test-token' }));

function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
  const enc = new TextEncoder();
  return {
    response: { ok: true, body },
    record(id: string, record: Record<string, unknown>, replay = false) {
      controller.enqueue(enc.encode(`id: ${id}\ndata: ${JSON.stringify({ record, replay })}\n\n`));
    },
    live(payload: Record<string, unknown>) { controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`)); },
    reset() { controller.enqueue(enc.encode('data: {"reset":true}\n\n')); },
    close() { controller.close(); },
  };
}

afterEach(() => vi.unstubAllGlobals());

const texts = (items: { kind: string; text?: string }[]) => items.map((i) => `${i.kind}:${i.text ?? ''}`);

describe('live drafts', () => {
  it('renders A -> tool -> B in order, each once, and durable records take over the draft ids', async () => {
    const s = stream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(s.response));
    const { result } = renderHook(() => useTranscript('s1'));
    await waitFor(() => expect(result.current.status).toBe('open'));
    act(() => {
      s.record('g:0', { kind: 'user', text: 'go' });
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 0, text: 'ALP' });
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 3, text: 'HA' });
    });
    await waitFor(() => expect(texts(result.current.items)).toEqual(['user:go', 'assistant:ALPHA']));
    const draftId = result.current.items[1]!.id;
    act(() => {
      s.live({ type: 'live_seal', seg: 0, part: 'text' });
      s.record('g:1', { kind: 'assistant', seg: 0, text: 'ALPHA' });
      s.record('g:2', { kind: 'tool', toolUseId: 't', toolName: 'bash', input: 'echo' });
      s.live({ type: 'live_delta', seg: 1, part: 'text', offset: 0, text: 'OMEGA' });
    });
    await waitFor(() => expect(texts(result.current.items)).toEqual(['user:go', 'assistant:ALPHA', 'tool:', 'assistant:OMEGA']));
    expect(result.current.items[1]!.id).toBe(draftId);
    act(() => {
      s.record('g:3', { kind: 'assistant', seg: 1, text: 'OMEGA' });
      s.live({ type: 'live_end', reason: 'done' });
      s.record('g:4', { kind: 'done' });
    });
    await waitFor(() => expect(result.current.turnActive).toBe(false));
    expect(texts(result.current.items.filter((i) => i.kind !== 'notice'))).toEqual(['user:go', 'assistant:ALPHA', 'tool:', 'assistant:OMEGA']);
  });

  it('drops duplicate deltas, waits for a snapshot after a gap, and a boundary+snapshot gives no dupes', async () => {
    const s = stream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(s.response));
    const { result } = renderHook(() => useTranscript('s1'));
    await waitFor(() => expect(result.current.status).toBe('open'));
    act(() => {
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 0, text: 'abc' });
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 0, text: 'abc' });
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 9, text: 'gap' });
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 3, text: 'def' });
    });
    await waitFor(() => expect(texts(result.current.items)).toEqual(['assistant:abc']));
    act(() => {
      s.reset();
      s.live({ type: 'live_snapshot', seg: 0, part: 'text', text: 'abcdefghi' });
    });
    await waitFor(() => expect(texts(result.current.items)).toEqual(['assistant:abcdefghi']));
  });

  it('an aborted turn keeps its unmatched draft as an interrupted item', async () => {
    const s = stream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(s.response));
    const { result } = renderHook(() => useTranscript('s1'));
    await waitFor(() => expect(result.current.status).toBe('open'));
    act(() => {
      s.live({ type: 'live_delta', seg: 0, part: 'text', offset: 0, text: 'half' });
      s.live({ type: 'live_end', reason: 'aborted' });
    });
    await waitFor(() => expect((result.current.items[0] as { live?: string } | undefined)?.live).toBe('interrupted'));
  });
});

describe('draft -> durable handover in the DOM', () => {
  it('keeps the same DOM node when the durable record replaces the draft, and durable text is not animated', () => {
    const draft = [{ kind: 'assistant' as const, id: 'live-1', text: 'Hello wor', live: 'streaming' }];
    const { container, rerender } = render(<TranscriptView items={draft} />);
    const node = container.querySelector('[data-live="streaming"]');
    expect(node).toBeTruthy();
    expect(container.querySelector('.streaming-cursor')).toBeTruthy();
    rerender(<TranscriptView items={[{ kind: 'assistant', id: 'live-1', text: 'Hello world' }]} />);
    const after = [...container.querySelectorAll('div')].find((d) => d.textContent?.includes('Hello world') && d.parentElement === node?.parentElement);
    expect(after).toBe(node);
    expect(container.querySelector('.streaming-cursor')).toBeNull();
    expect(container.textContent).toContain('Hello world');
  });

  it('holds back a half-typed code fence line while streaming', () => {
    expect(fenceSafeLength('intro\n```ty')).toBe('intro\n'.length);
    expect(fenceSafeLength('intro\n```ts\ncode')).toBe('intro\n```ts\ncode'.length);
  });
});
