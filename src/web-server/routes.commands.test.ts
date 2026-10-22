/**
 * Tests for POST /api/sessions/:id/commands route handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';

/** Untyped call-through mock; the precise signature is irrelevant to these tests. */
type AnyMock = Mock<(...args: unknown[]) => unknown>;
import type { ServerResponse } from 'node:http';

// --- mocks ---

let mockEnsureSlashRegistry: AnyMock;
let mockParse: AnyMock;
let mockLookup: AnyMock;
let mockSuggest: AnyMock;
let mockIsGated: AnyMock;
let mockGateReason: AnyMock;
let mockGetStats: AnyMock;
let mockBuildSessionRef: AnyMock;
let mockBuildOptionalSessionRef: AnyMock;
let mockCreateWebSlashContext: AnyMock;

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
  buildOptionalSessionRef: (...args: unknown[]) => mockBuildOptionalSessionRef(...args),
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
  mockBuildOptionalSessionRef = vi.fn().mockReturnValue(FAKE_REF);
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

  it('501 when turn accounting (reserveTurn/releaseTurn) is absent', async () => {
    // Contract: commands route requires isBusy+reserveTurn+releaseTurn to
    // guarantee turn serialization. Missing any → 501 commands_not_supported.
    const ctx = makeCtx({ reserveTurn: undefined, releaseTurn: undefined });
    const { res, json } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(501);
    expect((json().body as { error: string }).error).toBe('commands_not_supported');
  });

  it('501 when only releaseTurn is absent', async () => {
    const ctx = makeCtx({ releaseTurn: undefined });
    const { res, json } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(501);
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

  it('busy check does not call reserveTurn', async () => {
    const ctx = makeCtx({ isBusy: vi.fn().mockReturnValue(true) });
    const { res } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(ctx.reserveTurn).not.toHaveBeenCalled();
    expect(ctx.releaseTurn).not.toHaveBeenCalled();
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

  it('409 for gated command with reason', async () => {
    mockIsGated.mockReturnValue(true);
    mockGateReason.mockReturnValue('requires terminal readline');
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/clear' });
    expect(json().status).toBe(409);
    expect((json().body as { error: string }).error).toBe('command_gated');
    expect((json().body as { reason: string }).reason).toBe('requires terminal readline');
  });

  it('503 when stats not initialized', async () => {
    mockGetStats.mockReturnValue(undefined);
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(503);
  });

  it('503 when getSession is wired but returns undefined (session not ready)', async () => {
    // getSession present but returns undefined → session not available yet
    const ctx = makeCtx({ getSession: vi.fn().mockReturnValue(undefined) });
    const { res, json } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(503);
    expect((json().body as { error: string }).error).toBe('session_not_ready');
  });

  it('500 when handler throws', async () => {
    FAKE_CMD.handler = vi.fn().mockRejectedValue(new Error('boom'));
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(500);
    expect((json().body as { error: string }).error).toBe('command_execution_failed');
  });

  it('always calls releaseTurn even when handler throws', async () => {
    FAKE_CMD.handler = vi.fn().mockRejectedValue(new Error('boom'));
    const ctx = makeCtx();
    const { res } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(ctx.releaseTurn).toHaveBeenCalledWith(SESSION_ID);
  });

  it('always calls releaseTurn on gated command', async () => {
    mockIsGated.mockReturnValue(true);
    mockGateReason.mockReturnValue('reason');
    const ctx = makeCtx();
    const { res } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/clear' });
    expect(ctx.releaseTurn).toHaveBeenCalledWith(SESSION_ID);
  });

  it('happy path returns 200 with blocks and control', async () => {
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(200);
    const body = json().body as { blocks: unknown[]; control: { kind: string } };
    expect(body.blocks).toHaveLength(1);
    expect(body.control.kind).toBe('continue');
  });

  it('happy path: reserveTurn called before handler, releaseTurn after', async () => {
    const order: string[] = [];
    const ctx = makeCtx({
      reserveTurn: vi.fn().mockImplementation(() => { order.push('reserve'); }),
      releaseTurn: vi.fn().mockImplementation(() => { order.push('release'); }),
    });
    FAKE_CMD.handler = vi.fn().mockImplementation(async () => { order.push('handler'); return 'continue'; });
    const { res } = makeRes();
    await handleCommand(ctx, res, SESSION_ID, { input: '/help' });
    expect(order).toEqual(['reserve', 'handler', 'release']);
  });
});

// --- Auth test: POST to /commands without valid Origin/cookie must be rejected
// This is enforced at the server dispatch layer (server.ts bearer+Origin checks),
// not inside handleCommand itself. The server.test.ts integration tests cover the
// full auth flow. Here we confirm the handler itself does NOT enforce auth —
// auth is a server-level concern, consistent with how handlePrompt is tested.
describe('handleCommand — no server-level auth enforcement in unit tests', () => {
  it('handler itself does not check Origin (server dispatch layer does)', async () => {
    // handleCommand trusts that server.ts already enforced Origin+bearer.
    // If it reaches handleCommand, it proceeds normally.
    const { res, json } = makeRes();
    await handleCommand(makeCtx(), res, SESSION_ID, { input: '/help' });
    expect(json().status).toBe(200);
  });
});

describe('normalizeSlashResult — all 6 SlashResult variants', () => {
  it("'continue' → { kind: 'continue' }", () => {
    expect(normalizeSlashResult('continue')).toEqual({ kind: 'continue' });
  });
  it("'exit' → { kind: 'exit' }", () => {
    expect(normalizeSlashResult('exit')).toEqual({ kind: 'exit' });
  });
  it("'forward' → { kind: 'forward' }", () => {
    expect(normalizeSlashResult('forward')).toEqual({ kind: 'forward' });
  });
  it('{ rerun } → { kind: rerun, input }', () => {
    expect(normalizeSlashResult({ rerun: 'my cmd' })).toEqual({ kind: 'rerun', input: 'my cmd' });
  });
  it('{ kind: submit } → { kind: submit, message }', () => {
    expect(normalizeSlashResult({ kind: 'submit', message: 'hello' })).toEqual({ kind: 'submit', message: 'hello' });
  });
  it('{ kind: prefill } → { kind: prefill, message }', () => {
    expect(normalizeSlashResult({ kind: 'prefill', message: 'world' })).toEqual({ kind: 'prefill', message: 'world' });
  });
});
