import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './app';
import * as api from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
}));

// Silence React hook errors from missing SSE in jsdom
vi.mock('./hooks/use-sessions', () => ({
  useSessions: () => ({ sessions: [], loading: false }),
}));
vi.mock('./hooks/use-pending-approvals', () => ({
  usePendingApprovals: () => ({ approvals: [], pendingSessionIds: new Set() }),
}));
vi.mock('./hooks/use-transcript', () => ({
  useTranscript: () => ({
    items: [],
    totals: { cost: 0, tokens: 0, turns: 0 },
    status: 'idle',
    turnActive: false,
    liveTurns: 0,
  }),
}));
vi.mock('./hooks/use-scroll-pin', () => ({
  useScrollPin: () => ({
    containerRef: { current: null },
    scrollToBottom: vi.fn(),
    isPinned: true,
    showScrollButton: false,
  }),
}));
vi.mock('./hooks/use-queue', () => ({
  useQueue: () => ({
    enqueue: vi.fn(),
    flush: vi.fn(),
    clear: vi.fn(),
    queue: [],
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('App — new session includes model', () => {
  it('POSTs {model} when creating a new session', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({ session: { id: 'new-sess' } });

    render(<App />);

    // Find and click the New Session button (Plus icon, title="New Session")
    const newBtn = screen.getByTitle('New Session');
    fireEvent.click(newBtn);

    await waitFor(() => {
      const calls = vi.mocked(api.apiFetch).mock.calls;
      const sessionCall = calls.find(
        (c) => String(c[0]) === '/api/sessions' &&
               (c[1] as { method?: string })?.method === 'POST',
      );
      expect(sessionCall).toBeTruthy();
      const body = JSON.parse(
        (sessionCall![1] as { body?: string })?.body ?? '{}',
      ) as { model?: string };
      expect(body.model).toBeTruthy();
      expect(typeof body.model).toBe('string');
    });
  });
});
