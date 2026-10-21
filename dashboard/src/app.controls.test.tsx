import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { clearCommandsCache } from './components/composer';
import { apiFetch } from './lib/api';
import type { CommandResponse } from './types/command-wire';

vi.mock('./lib/api', () => ({
  apiFetch: vi.fn(), getToken: () => null,
  ApiError: class extends Error {},
}));
vi.mock('./hooks/use-sessions', () => ({
  useSessions: () => ({
    sessions: [
      { id: 'one', mode: 'live', title: 'First session', model: 'haiku' },
      { id: 'two', mode: 'live', title: 'Second session', model: 'sonnet' },
    ], loading: false,
  }),
}));
vi.mock('./hooks/use-pending-approvals', () => ({
  usePendingApprovals: () => ({ approvals: [], pendingSessionIds: new Set() }),
}));
vi.mock('./hooks/use-scroll-pin', () => ({
  useScrollPin: () => ({ containerRef: { current: null }, scrollToBottom: vi.fn(), isPinned: true }),
}));

let streams: ReadableStreamDefaultController<Uint8Array>[];
let fetchStream: ReturnType<typeof vi.fn>;
let response: CommandResponse;

beforeEach(() => {
  vi.clearAllMocks();
  clearCommandsCache();
  streams = [];
  fetchStream = vi.fn().mockImplementation(async () => ({
    ok: true,
    body: new ReadableStream<Uint8Array>({ start(controller) { streams.push(controller); } }),
  }));
  vi.stubGlobal('fetch', fetchStream);
  response = { blocks: [], control: { kind: 'continue' } };
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    if (url === '/api/models') return { models: [] };
    if (url === '/api/commands') return { commands: [] };
    return response;
  });
});
afterEach(() => vi.unstubAllGlobals());

async function selectFirst() {
  render(<App />);
  fireEvent.click(screen.getAllByText('First session')[0]!.closest('button')!);
  await waitFor(() => expect(streams).toHaveLength(1));
  return screen.getByRole('textbox');
}
async function command(ta: HTMLElement, input: string) {
  fireEvent.change(ta, { target: { value: input } });
  fireEvent.keyDown(ta, { key: 'Enter' });
  await waitFor(() => expect((ta as HTMLTextAreaElement).value).toBe(''));
}
function record(stream: number, id: number, text: string) {
  streams[stream]!.enqueue(new TextEncoder().encode(`id: ${id}\ndata: ${JSON.stringify({ record: { kind: 'user', text }, replay: true })}\n\n`));
}

describe('Dashboard session controls', () => {
  it('clear removes old transcript and local outputs, retains confirmation, and ignores late old replay', async () => {
    const ta = await selectFirst();
    act(() => {
      record(0, 1, 'Old transcript message');
      streams[0]!.enqueue(new TextEncoder().encode('id: 2\ndata: {"record":{"kind":"done"},"replay":true}\n\n'));
    });
    await screen.findByText('Old transcript message');
    response = { blocks: [{ text: 'Old command output', ansi: 'Old command output' }], control: { kind: 'continue' } };
    await command(ta, '/cost ');
    expect(screen.getByText('Old command output')).toBeTruthy();

    response = { blocks: [{ text: 'Conversation cleared.', ansi: 'Conversation cleared.' }], control: { kind: 'clear' } };
    await command(ta, '/clear ');
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(screen.queryByText('Old transcript message')).toBeNull();
    expect(screen.queryByText('Old command output')).toBeNull();
    expect(screen.getByText('Conversation cleared.')).toBeTruthy();
    expect((fetchStream.mock.calls[1]![1] as RequestInit).headers).not.toHaveProperty('last-event-id');

    act(() => {
      record(0, 2, 'Late stale replay');
      record(1, 1, 'New transcript message');
    });
    await screen.findByText('New transcript message');
    expect(screen.queryByText('Late stale replay')).toBeNull();
    expect(screen.getByText('Conversation cleared.')).toBeTruthy();
  });

  it('failed clear keeps existing outputs and does not restart the stream', async () => {
    const ta = await selectFirst();
    response = { blocks: [{ text: 'Keep this output', ansi: 'Keep this output' }], control: { kind: 'continue' } };
    await command(ta, '/cost ');
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Reset failed'));
    fireEvent.change(ta, { target: { value: '/clear ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await screen.findByText('Error: Reset failed');
    expect(screen.getByText('Keep this output')).toBeTruthy();
    expect(streams).toHaveLength(1);
    expect((ta as HTMLTextAreaElement).value).toBe('/clear ');
  });

  it('reflects authoritative /model in selector and sidebar, and session navigation restores each model', async () => {
    const ta = await selectFirst();
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('haiku');
    expect(vi.mocked(apiFetch).mock.calls.some(([url]) => String(url).includes('/commands'))).toBe(false);
    response = { blocks: [], control: { kind: 'continue' }, session: { model: 'org/CaseSensitiveModel' } };
    await command(ta, '/model org/CaseSensitiveModel');
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('org/CaseSensitiveModel');
    expect(screen.getAllByText('org/CaseSensitiveModel').length).toBeGreaterThan(1);
    expect(screen.getByTitle('Session model').textContent).toBe('org/CaseSensitiveModel');
    await act(async () => fireEvent.click(screen.getAllByText('Second session')[0]!.closest('button')!));
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('sonnet');
    await act(async () => fireEvent.click(screen.getAllByText('First session')[0]!.closest('button')!));
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('org/CaseSensitiveModel');
  });

  it('model selector sends /model and does not change model before successful metadata', async () => {
    await selectFirst();
    let resolve!: (value: unknown) => void;
    vi.mocked(apiFetch).mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'opus' } });
    await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/sessions/one/commands', {
      method: 'POST', body: JSON.stringify({ input: '/model opus' }),
    }));
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('haiku');
    await act(async () => resolve({ blocks: [], control: { kind: 'continue' }, session: { model: 'opus' } }));
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('opus');
  });

  it('does not optimistically update model when the server rejects the picker change', async () => {
    await selectFirst();
    vi.mocked(apiFetch).mockRejectedValueOnce(new Error('Model unavailable'));
    fireEvent.change(screen.getByRole('combobox', { name: 'Model' }), { target: { value: 'opus' } });
    await screen.findByText('Error: Model unavailable');
    expect((screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement).value).toBe('haiku');
  });

  it('ignores a delayed clear response after navigation to another session', async () => {
    const ta = await selectFirst();
    let resolve!: (value: unknown) => void;
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (url === '/api/models') return { models: [] };
      if (url === '/api/commands') return { commands: [] };
      return new Promise((done) => { resolve = done; });
    });
    fireEvent.change(ta, { target: { value: '/clear ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    await act(async () => fireEvent.click(screen.getAllByText('Second session')[0]!.closest('button')!));
    act(() => record(1, 1, 'Second session transcript'));
    await screen.findByText('Second session transcript');
    await act(async () => resolve({ blocks: [{ text: 'Old session cleared', ansi: 'Old session cleared' }], control: { kind: 'clear' } }));
    expect(screen.getByText('Second session transcript')).toBeTruthy();
    expect(screen.queryByText('Old session cleared')).toBeNull();
    expect(streams).toHaveLength(2);
  });

  it('/name metadata updates sidebar title without parsing command output', async () => {
    const ta = await selectFirst();
    response = { blocks: [], control: { kind: 'continue' }, session: { name: 'Renamed project' } };
    await command(ta, '/name Renamed project');
    expect(screen.queryByText('First session')).toBeNull();
    expect(screen.getAllByText('Renamed project').length).toBeGreaterThan(0);
  });
});
