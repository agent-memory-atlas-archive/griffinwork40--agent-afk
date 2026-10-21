import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getSessionLedgerDir, getSessionLedgerPath } from '../paths.js';
import { handleStream } from './stream-route.js';
import { parseSseChunk } from './sse-protocol.js';

const id = 'reset-stream';
const record = (text: string) => JSON.stringify({ v: 1, ts: Date.now(), kind: 'assistant', text }) + '\n';
function replace(text: string) {
  const file = getSessionLedgerPath(id);
  writeFileSync(`${file}.next`, record(text));
  renameSync(`${file}.next`, file);
}
function connect(lastEventId?: string) {
  const req = Object.assign(new EventEmitter(), { headers: { ...(lastEventId ? { 'last-event-id': lastEventId } : {}) } });
  let raw = '';
  const res = { writeHead: vi.fn(), flushHeaders: vi.fn(), write: (chunk: string) => { raw += chunk; }, end: vi.fn() };
  const done = handleStream(req as IncomingMessage, res as unknown as ServerResponse, id);
  return {
    res, done,
    frames: () => parseSseChunk(raw).events.map((e) => ({ id: e.id, data: JSON.parse(e.data) })),
    disconnect: () => req.emit('close'),
  };
}
beforeEach(() => {
  vi.stubEnv('AFK_STATE_DIR', mkdtempSync(join(tmpdir(), 'sse-reset-')));
  mkdirSync(getSessionLedgerDir(id), { recursive: true });
});
afterEach(() => vi.unstubAllEnvs());

describe('stream clear generations (real disk tailers)', () => {
  it('keeps two existing clients alive across reset seals, emits resets before new data on repeated clears', async () => {
    writeFileSync(getSessionLedgerPath(id), record('old'));
    const tabs = [connect(), connect()];
    try {
      await vi.waitFor(() => tabs.forEach((tab) => expect(tab.frames()).toHaveLength(1)));
      appendFileSync(getSessionLedgerPath(id), JSON.stringify({ v: 1, ts: Date.now(), kind: 'closed', reason: 'reset' }) + '\n');
      await new Promise((resolve) => setTimeout(resolve, 300));
      tabs.forEach((tab) => expect(tab.res.end).not.toHaveBeenCalled());
      replace('new'.repeat(1000));
      await vi.waitFor(() => tabs.forEach((tab) => expect(tab.frames()).toHaveLength(3)));
      replace('final');
      await vi.waitFor(() => tabs.forEach((tab) => expect(tab.frames()).toHaveLength(5)));
      for (const tab of tabs) {
        const frames = tab.frames();
        expect(frames.map((f) => f.data.reset ?? f.data.record.text)).toEqual(['old', true, 'new'.repeat(1000), true, 'final']);
        expect(new Set(frames.filter((f) => f.id).map((f) => f.id)).size).toBe(3);
        expect(frames.some((f) => f.data.end)).toBe(false);
      }
    } finally { tabs.forEach((tab) => tab.disconnect()); await Promise.all(tabs.map((tab) => tab.done)); }
  });

  it('rebases an old-generation reconnect cursor, then resumes the new generation without duplicates', async () => {
    writeFileSync(getSessionLedgerPath(id), record('old'));
    const first = connect();
    await vi.waitFor(() => expect(first.frames()).toHaveLength(1));
    const oldCursor = first.frames()[0]!.id!;
    first.disconnect(); await first.done;
    replace('new');
    const second = connect(oldCursor);
    try {
      await vi.waitFor(() => expect(second.frames()).toHaveLength(2));
      expect(second.frames()[0]?.data).toEqual({ reset: true });
      expect(second.frames()[1]?.data).toMatchObject({ record: { text: 'new' }, replay: true });
      const newCursor = second.frames()[1]!.id!;
      second.disconnect(); await second.done;
      appendFileSync(getSessionLedgerPath(id), record('next'));
      const third = connect(newCursor);
      try {
        await vi.waitFor(() => expect(third.frames()).toHaveLength(1));
        expect(third.frames()[0]?.data.record.text).toBe('next');
      } finally { third.disconnect(); await third.done; }
    } finally { second.disconnect(); await second.done; }
  });
});
