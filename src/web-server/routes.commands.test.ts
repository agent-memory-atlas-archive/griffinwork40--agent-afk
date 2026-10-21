/**
 * Tests for POST /api/sessions/:id/commands route handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerResponse } from 'node:http';

// --- mocks ---

let mockEnsureSlashRegistry: ReturnType<typeof vi.fn>;
let mockParse: ReturnType<typeof vi.fn>;
let mockLookup: ReturnType<typeof vi.fn>;
let mockSuggest: ReturnType<typeof vi.fn>;
let mockIsGated: ReturnType<typeof vi.fn>;
let mockGateReason: ReturnType<typeof vi.fn>;
let mockGetStats: ReturnType<typeof vi.fn>;
let mockBuildSessionRef: ReturnType<typeof vi.fn>;
let mockCreateWebSlashContext: ReturnType<typeof vi.fn>;

vi.mock('./slash-registry.js', () => ({
  ensureSlashRegistry: (...args: unknown[]) => mockEnsureSlashRegistry(...args),
}));
vi.mock('../cli/slash/registry.js', () => ({
  parse: (...args: unknown[]) => mockParse(...args),
  lookup: (...args: unknown[]) => mockLookup(...args),
  suggest: (...args: unknown[]) => mockSuggest(...args),
}));
vi.mock('./command-gate.js', () => ({
  isGated: (...args: unknown[]) => mockIsGated(...args),
  gateReason: (...args: unknown[]) => mockGateReason(...args),
}));
vi.mock('./session-owner.slash.js', () => ({
  getStats: (...args: unknown[]) => mockGetStats(...args),
  buildSessionRef: (...args: unknown[]) => mockBuildSessionRef(...args),
}));
vi.mock('./slash-context.web.js', () => ({
  createWebSlashContext: (...args: unknown[]) => mockCreateWebSlashContext(...args),
}));
vi.mock('./writer.buffer.js', () => ({
  BufferingWriter: class {
    fn = vi.fn();
    rawFn = vi.fn();
    getChunks = vi.fn().mockReturnValue([]);
    asWriterInterface = vi.fn().mockReturnValue({});
    toOutputBlock = vi.fn().mockReturnValue({ ansi: 'output', text: 'output' });
  },
}));

import { handleCommand, normalizeSlashResult } from './routes.commands.js';

// --- helpers ---

function makeRes(): { res: ServerResponse; json: () => { status: number; body: unknown } } {
  let status = 0;
  const chunks: string[] = [];
  const res = {
    writeHead(s: number) { status = s; },
    end(payload: string) { chunks.push(payload); },
  } as unknown as ServerResponse;
  return { res, json: () => ({ status, body: JSON.parse(chunks.join('')) as unknown }) };
}

const SESSION_ID = 'test-session-abc123';

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    owned: new Set([SESSION_ID]),
    bridge: {} as never,
    submitPrompt: vi.fn(),
    isBusy: vi.fn().mockReturnValue(false),
    reserveTurn: vi.fn(),
    releaseTurn: vi.fn(),
    getSessionCwd: vi.fn().mockReturnValue('/tmp'),
    getSession: vi.fn().mockReturnValue({ sessionId: SESSION_ID }),
    ...overrides,
  };
}

const FAKE_CMD = {
  name: '/help',
  acceptsAttachments: false,
  handler: vi.fn().mockResolvedValue('continue'),
};

const FAKE_STATS = { totalTurns: 0, model: 'sonnet' } as never;
const FAKE_REF = { current: {} } as never;
const FAKE_CTX = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureSlashRegistry = vi.fn().mockResolvedValue(undefined);
  mockParse = vi.fn().mockReturnValue({ name: '/help', args: '' });
  mockLookup = vi.fn().mockReturnValue(FAKE_CMD);
  mockSuggest = vi.fn().mockReturnValue(undefined);
  mockIsGated = vi.fn().mockReturnValue(false);
  mockGateReason = vi.fn().mockReturnValue(undefined);
  mockGetStats = vi.fn().mockReturnValue(FAKE_STATS);
  mockBuildSessionRef = vi.fn().mockReturnValue(FAKE_REF);
  mockCreateWebSlashContext = vi.fn().mockReturnValue(FAKE_CTX);
  FAKE_CMD.handler = vi.fn().mockResolvedValue('continue');
});

describe('handleCommand', () => {
  it('400 for invalid session id', async () => {
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, '../bad', { input: '/help' });
    expect(json().status).toBe(400);
    expect((json().body as { error: string }).error).toBe('bad_session_id');
  });

  it('409 for unowned session', async () => {
    const ctx = makeCtx({ owned: new Set() });
    const { res, json } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(409);
    expect((json().body as { error: string }).error).toBe('session_not_owned');
  });

  it('400 for missing input field', async () => {
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, {});
    expect(json().status).toBe(400);
    expect((json().body as { error: string }).error).toBe('bad_request');
  });

  it('409 for busy session', async () => {
    const ctx = makeCtx({ isBusy: vi.fn().mockReturnValue(true) });
    const { res, json } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(409);
    expect((json().body as { error: string }).error).toBe('session_busy');
  });

  it('404 for unknown command with no suggestion', async () => {
    mockLookup.mockReturnValue(undefined);
    mockSuggest.mockReturnValue(undefined);
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/unknown' });
    expect(json().status).toBe(404);
    expect((json().body as { error: string }).error).toBe('unknown_command');
    expect((json().body as { suggestion?: string }).suggestion).toBeUndefined();
  });

  it('404 for unknown command includes suggestion', async () => {
    mockLookup.mockReturnValue(undefined);
    mockSuggest.mockReturnValue('/help');
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/hlep' });
    expect(json().status).toBe(404);
    expect((json().body as { suggestion: string }).suggestion).toBe('/help');
  });

  it('409 for gated command', async () => {
    mockIsGated.mockReturnValue(true);
    mockGateReason.mockReturnValue('requires terminal readline');
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/clear' });
    expect(json().status).toBe(409);
    expect((json().body as { error: string }).error).toBe('command_gated');
    expect((json().body as { reason: string }).reason).toBe('requires terminal readline');
  });

  it('500 when handler throws', async () => {
    FAKE_CMD.handler = vi.fn().mockRejectedValue(new Error('boom'));
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(500);
    expect((json().body as { error: string }).error).toBe('command_execution_failed');
  });

  it('always calls releaseTurn even on error', async () => {
    FAKE_CMD.handler = vi.fn().mockRejectedValue(new Error('boom'));
    const ctx = makeCtx();
    const { res } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(ctx.releaseTurn).toHaveBeenCalled();
  });

  it('happy path returns 200 with blocks and control', async () => {
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(200);
    const body = json().body as { blocks: unknown[]; control: { kind: string } };
    expect(body.blocks).toHaveLength(1);
    expect(body.control.kind).toBe('continue');
  });

  it('503 when stats not initialized', async () => {
    mockGetStats.mockReturnValue(undefined);
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(503);
  });
});

describe('normalizeSlashResult', () => {
  it("'continue' → { kind: 'continue' }", () => {
    expect(normalizeSlashResult('continue')).toEqual({ kind: 'continue' });
  });
  it("'exit' → { kind: 'exit' }", () => {
    expect(normalizeSlashResult('exit')).toEqual({ kind: 'exit' });
  });
  it("'forward' → { kind: 'forward' }", () => {
    expect(normalizeSlashResult('forward')).toEqual({ kind: 'forward' });
  });
  it('rerun object', () => {
    expect(normalizeSlashResult({ rerun: 'my cmd' })).toEqual({ kind: 'rerun', input: 'my cmd' });
  });
  it('submit object', () => {
    expect(normalizeSlashResult({ kind: 'submit', message: 'hello' })).toEqual({ kind: 'submit', message: 'hello' });
  });
  it('prefill object', () => {
    expect(normalizeSlashResult({ kind: 'prefill', message: 'world' })).toEqual({ kind: 'prefill', message: 'world' });
  });
});
