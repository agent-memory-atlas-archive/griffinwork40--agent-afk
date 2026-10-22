import { afterEach, describe, expect, it, vi } from 'vitest';
import { LiveBroker } from './live-broker.js';
import type { LiveSsePayload } from './shared/live-wire.js';
import type { OutputEvent } from '../agent/types/session-types.js';
import { drainAndPersistTurn } from './session-owner.autosave.js';
import type { AgentSession } from '../agent/session/agent-session.js';

const text = (content: string): OutputEvent => ({ type: 'chunk', chunk: { type: 'content', content } });
const tool = { type: 'chunk', chunk: { type: 'tool_use_detail', toolUseId: 't', toolName: 'bash', toolInput: '' } } as OutputEvent;

afterEach(() => vi.useRealTimers());

describe('LiveBroker', () => {
  it('batches deltas into one frame per ~50 ms window', () => {
    vi.useFakeTimers();
    const broker = new LiveBroker(50);
    const got: LiveSsePayload[] = [];
    broker.subscribe('s', (e) => got.push(e));
    broker.beginTurn('s');
    broker.observe('s', text('a'));
    broker.observe('s', text('b'));
    broker.observe('s', text('c'));
    expect(got).toEqual([]);
    vi.advanceTimersByTime(50);
    expect(got).toEqual([{ type: 'live_delta', seg: 0, part: 'text', offset: 0, text: 'abc' }]);
  });

  it('snapshot holds the OPEN segment only (sealed text arrives via the ledger)', () => {
    const broker = new LiveBroker(50);
    broker.beginTurn('s');
    broker.observe('s', text('ALPHA'));
    broker.observe('s', tool);
    broker.observe('s', text('OME'));
    expect(broker.snapshot('s')).toEqual([{ type: 'live_snapshot', seg: 1, part: 'text', text: 'OME' }]);
  });

  it('flushes pending deltas before the seal, in order', () => {
    const broker = new LiveBroker(50);
    const got: LiveSsePayload[] = [];
    broker.subscribe('s', (e) => got.push(e));
    broker.beginTurn('s');
    broker.observe('s', text('ALPHA'));
    broker.observe('s', tool);
    expect(got.map((e) => e.type)).toEqual(['live_delta', 'live_seal']);
  });

  it('isolates sessions', () => {
    const broker = new LiveBroker(50);
    const a: LiveSsePayload[] = [];
    broker.subscribe('a', (e) => a.push(e));
    broker.beginTurn('b');
    broker.observe('b', text('other'));
    broker.endTurn('b', 'done');
    expect(a).toEqual([]);
    expect(broker.snapshot('a')).toEqual([]);
  });

  it('endTurn reports the observed terminal, flushes, and drops turn state', () => {
    const broker = new LiveBroker(50);
    const got: LiveSsePayload[] = [];
    broker.subscribe('s', (e) => got.push(e));
    broker.beginTurn('s');
    broker.observe('s', text('x'));
    broker.observe('s', { type: 'done' } as OutputEvent);
    broker.endTurn('s', 'aborted');
    expect(got.at(-1)).toEqual({ type: 'live_end', reason: 'done' });
    expect(broker.snapshot('s')).toEqual([]);
  });

  it('a throwing subscriber does not break peers', () => {
    const broker = new LiveBroker(0);
    const got: LiveSsePayload[] = [];
    broker.subscribe('s', () => { throw new Error('socket gone'); });
    broker.subscribe('s', (e) => got.push(e));
    broker.beginTurn('s');
    broker.endTurn('s', 'aborted');
    expect(got).toEqual([{ type: 'live_end', reason: 'aborted' }]);
  });
});

describe('drainAndPersistTurn live tap', () => {
  it('calls endTurn in finally even when the stream throws', async () => {
    const sink = { beginTurn: vi.fn(), observe: vi.fn(), endTurn: vi.fn() };
    const session = {
      async *sendMessageStream() { yield text('partial'); throw new Error('stream failed'); },
    } as unknown as AgentSession;
    await expect(drainAndPersistTurn(session, 'q', undefined, undefined, { sink, sessionId: 's' })).rejects.toThrow('stream failed');
    expect(sink.beginTurn).toHaveBeenCalledWith('s');
    expect(sink.observe).toHaveBeenCalledTimes(1);
    expect(sink.endTurn).toHaveBeenCalledWith('s', 'error');
  });

  it('reports done for a completed turn', async () => {
    const sink = { beginTurn: vi.fn(), observe: vi.fn(), endTurn: vi.fn() };
    const session = { async *sendMessageStream() { yield { type: 'done' }; } } as unknown as AgentSession;
    await drainAndPersistTurn(session, 'q', undefined, undefined, { sink, sessionId: 's' });
    expect(sink.endTurn).toHaveBeenCalledWith('s', 'done');
  });
});
