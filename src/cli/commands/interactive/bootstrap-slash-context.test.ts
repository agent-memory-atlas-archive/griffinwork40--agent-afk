import { afterEach, describe, expect, it, vi } from 'vitest';
import { createReplSlashContext } from './bootstrap-slash-context.js';
import { createSessionStats } from '../../slash/session-stats.js';
import { createConsoleWriter } from '../../slash/writer.js';
import { dispatch, register, resetRegistry } from '../../slash/registry.js';
import { FastModeController } from '../../../agent/fast-mode.js';

type ContextArgs = Parameters<typeof createReplSlashContext>[0];
const originalStdinTty = process.stdin.isTTY;
const originalStdoutTty = process.stdout.isTTY;

function setTty(stdin: boolean | undefined, stdout: boolean | undefined) {
  (process.stdin as { isTTY?: boolean }).isTTY = stdin;
  (process.stdout as { isTTY?: boolean }).isTTY = stdout;
}

function makeContext() {
  // Unused owner facilities are opaque here: context creation must not touch
  // the provider, samplers, or terminal until a handler invokes them.
  return createReplSlashContext({
    sessionRef: {},
    stats: createSessionStats('sonnet'),
    writer: createConsoleWriter({ fn: vi.fn() }),
    statusLine: {},
    contextSampler: {},
    gitStatusSampler: {},
    ledger: {},
    mcpManager: undefined,
    fastModeController: new FastModeController(),
  } as unknown as ContextArgs);
}

afterEach(() => {
  setTty(originalStdinTty, originalStdoutTty);
  vi.restoreAllMocks();
  resetRegistry();
});

describe('REPL surface declaration', () => {
  it.each([
    [true, true, true],
    [false, true, false],
    [true, false, false],
    [false, false, false],
    [undefined, undefined, false],
  ])('stdin TTY %s / stdout TTY %s declares tty=%s', (stdin, stdout, tty) => {
    setTty(stdin, stdout);
    const ctx = makeContext();
    expect(ctx.capabilities?.has('tty')).toBe(tty);
    expect([...ctx.capabilities!].filter((capability) => capability !== 'tty').sort()).toEqual([
      'consoleOutput', 'conversationRetry', 'hostCredentials',
      'permissionMode', 'sessionControl', 'shellJobs',
    ]);
    expect(ctx.capabilities).not.toBe(makeContext().capabilities);
  });

  it('gates terminal commands on non-TTY REPLs while allowing owner commands', async () => {
    setTty(false, false);
    const ctx = makeContext();
    const terminal = vi.fn(async () => 'continue' as const);
    const control = vi.fn(async () => 'continue' as const);
    register({ name: '/editor', summary: 'terminal', handler: terminal });
    register({ name: '/model', summary: 'owner', handler: control });
    await dispatch('/editor', ctx);
    await dispatch('/model', ctx);
    expect(terminal).not.toHaveBeenCalled();
    expect(control).toHaveBeenCalledOnce();
  });
});
