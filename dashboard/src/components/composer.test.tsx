import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Composer, clearCommandsCache } from './composer';
import * as api from '@/lib/api';
import type { SlashCommand } from '@/types/api';
import type { CommandResponse } from '@/types/command-wire';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

function skill(name: string, web: 'ok' | 'gated' = 'ok'): SlashCommand {
  return { name, summary: 'test', kind: 'skill', web };
}
function native(name: string, web: 'ok' | 'gated' = 'ok', gateReason?: string): SlashCommand {
  return { name, summary: 'test', kind: 'native', web, gateReason };
}

const baseProps = {
  sessionId: 'sess-1',
  sessionMode: 'live' as const,
  isBusy: false,
};

/** Type a value that closes autocomplete (trailing space => slashQuery becomes null) */
function typeAndSubmit(ta: HTMLElement, value: string) {
  fireEvent.change(ta, { target: { value } });
  fireEvent.keyDown(ta, { key: 'Enter' });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearCommandsCache();
});

// ---------------------------------------------------------------------------
// Routing branches
// ---------------------------------------------------------------------------

describe('Composer routing — skill command', () => {
  it('routes skill command to /prompt', async () => {
    vi.mocked(api.apiFetch)
      .mockResolvedValueOnce({ commands: [skill('my-skill')] })
      .mockResolvedValueOnce({});

    render(<Composer {...baseProps} />);
    const ta = screen.getByRole('textbox');
    // trailing space closes autocomplete, Enter then submits
    typeAndSubmit(ta, '/my-skill do stuff');

    await waitFor(() => {
      const calls = vi.mocked(api.apiFetch).mock.calls;
      const promptCall = calls.find((c) => String(c[0]).includes('/prompt'));
      expect(promptCall).toBeTruthy();
    });
  });
});

describe('Composer routing — native ok command', () => {
  it('routes native ok command to /commands', async () => {
    const response: CommandResponse = { blocks: [], control: { kind: 'continue' } };
    vi.mocked(api.apiFetch)
      .mockResolvedValueOnce({ commands: [native('help')] })
      .mockResolvedValueOnce(response);

    const onCommandOutput = vi.fn();
    render(<Composer {...baseProps} onCommandOutput={onCommandOutput} />);
    const ta = screen.getByRole('textbox');
    // "/help " — trailing space closes autocomplete so Enter submits
    typeAndSubmit(ta, '/help ');

    await waitFor(() => {
      const calls = vi.mocked(api.apiFetch).mock.calls;
      const cmdCall = calls.find((c) => String(c[0]).includes('/commands'));
      expect(cmdCall).toBeTruthy();
    });
    await waitFor(() => expect(onCommandOutput).toHaveBeenCalled());
  });
});

describe('Composer routing — native gated command', () => {
  it('shows gate reason toast and makes no /commands or /prompt call', async () => {
    vi.mocked(api.apiFetch).mockResolvedValueOnce({
      commands: [native('sh', 'gated', 'Requires TTY')],
    });

    const onToast = vi.fn();
    render(<Composer {...baseProps} onToast={onToast} />);
    const ta = screen.getByRole('textbox');
    // Use trailing space so autocomplete is closed; trimmed value = '/sh some-cmd'
    typeAndSubmit(ta, '/sh some-cmd ');

    await waitFor(() => expect(onToast).toHaveBeenCalledWith('Requires TTY'));
    // Only one apiFetch call: fetchCommands (/api/commands) — no /commands route, no /prompt
    const calls = vi.mocked(api.apiFetch).mock.calls;
    const nonCommandCalls = calls.filter(
      (c) => !String(c[0]).includes('/api/commands'),
    );
    expect(nonCommandCalls).toHaveLength(0);
  });
});

describe('Composer routing — plain text', () => {
  it('sends plain text to /prompt without fetching commands', async () => {
    vi.mocked(api.apiFetch).mockResolvedValueOnce({});
    render(<Composer {...baseProps} />);
    const ta = screen.getByRole('textbox');
    typeAndSubmit(ta, 'hello world');

    await waitFor(() => {
      const calls = vi.mocked(api.apiFetch).mock.calls;
      const promptCall = calls.find((c) => String(c[0]).includes('/prompt'));
      expect(promptCall).toBeTruthy();
    });
  });
});

// ---------------------------------------------------------------------------
// Control kind handling
// ---------------------------------------------------------------------------

describe('Composer control — prefill', () => {
  it('fills composer with control.message without submitting', async () => {
    const response: CommandResponse = {
      blocks: [],
      control: { kind: 'prefill', message: 'prefilled text' },
    };
    vi.mocked(api.apiFetch)
      .mockResolvedValueOnce({ commands: [native('prefill-cmd')] })
      .mockResolvedValueOnce(response);

    const onCommandOutput = vi.fn();
    render(<Composer {...baseProps} onCommandOutput={onCommandOutput} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    // trailing space so autocomplete closes; trimmed = '/prefill-cmd args'
    typeAndSubmit(ta, '/prefill-cmd args ');

    // Wait for /commands to respond (onCommandOutput fires after response arrives)
    await waitFor(() => expect(onCommandOutput).toHaveBeenCalled(), { timeout: 2000 });
    // After prefill control, textarea should have the prefilled value
    await waitFor(() => {
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('prefilled text');
    }, { timeout: 2000 });
    // No /prompt call (prefill does not auto-submit)
    const calls = vi.mocked(api.apiFetch).mock.calls;
    expect(calls.every((c) => !String(c[0]).includes('/prompt'))).toBe(true);
  });
});

describe('Composer control — submit', () => {
  it('submits control.message via prompt path', async () => {
    const response: CommandResponse = {
      blocks: [],
      control: { kind: 'submit', message: 'auto-submit me' },
    };
    vi.mocked(api.apiFetch)
      .mockResolvedValueOnce({ commands: [native('submit-cmd')] })
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({});

    render(<Composer {...baseProps} />);
    const ta = screen.getByRole('textbox');
    typeAndSubmit(ta, '/submit-cmd ');

    await waitFor(() => {
      const calls = vi.mocked(api.apiFetch).mock.calls;
      const promptCall = calls.find(
        (c) =>
          String(c[0]).includes('/prompt') &&
          ((c[1] as { body?: string })?.body ?? '').includes('auto-submit me'),
      );
      expect(promptCall).toBeTruthy();
    });
  });
});

describe('Composer control — forward', () => {
  it('forwards original input to /prompt', async () => {
    const response: CommandResponse = { blocks: [], control: { kind: 'forward' } };
    vi.mocked(api.apiFetch)
      .mockResolvedValueOnce({ commands: [native('fwd-cmd')] })
      .mockResolvedValueOnce(response)
      .mockResolvedValueOnce({});

    render(<Composer {...baseProps} />);
    const ta = screen.getByRole('textbox');
    typeAndSubmit(ta, '/fwd-cmd ');

    await waitFor(() => {
      const calls = vi.mocked(api.apiFetch).mock.calls;
      const promptCall = calls.find(
        (c) =>
          String(c[0]).includes('/prompt') &&
          ((c[1] as { body?: string })?.body ?? '').includes('/fwd-cmd'),
      );
      expect(promptCall).toBeTruthy();
    });
  });
});

describe('Composer control — exit', () => {
  it('shows toast about exit, no session close', async () => {
    const response: CommandResponse = { blocks: [], control: { kind: 'exit' } };
    vi.mocked(api.apiFetch)
      .mockResolvedValueOnce({ commands: [native('exit-cmd')] })
      .mockResolvedValueOnce(response);

    const onToast = vi.fn();
    render(<Composer {...baseProps} onToast={onToast} />);
    const ta = screen.getByRole('textbox');
    typeAndSubmit(ta, '/exit-cmd ');

    await waitFor(() => expect(onToast).toHaveBeenCalled());
    const msg: string = onToast.mock.calls[0]?.[0] ?? '';
    expect(msg.toLowerCase()).toContain('session');
  });
});

describe('Composer control — continue', () => {
  it('does nothing extra on continue', async () => {
    const response: CommandResponse = { blocks: [], control: { kind: 'continue' } };
    vi.mocked(api.apiFetch)
      .mockResolvedValueOnce({ commands: [native('noop-cmd')] })
      .mockResolvedValueOnce(response);

    const onToast = vi.fn();
    render(<Composer {...baseProps} onToast={onToast} />);
    const ta = screen.getByRole('textbox');
    typeAndSubmit(ta, '/noop-cmd ');

    await waitFor(() => {
      const calls = vi.mocked(api.apiFetch).mock.calls;
      expect(calls.length).toBe(2);
    });
    expect(onToast).not.toHaveBeenCalled();
  });
});
