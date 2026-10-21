import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ApprovalCards } from './approval-cards';
import type { PendingApproval } from '@/types/api';
import * as api from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn().mockResolvedValue({}),
}));

function makeApproval(overrides: Partial<PendingApproval['request']> = {}): PendingApproval {
  return {
    id: 'req-1',
    request: {
      title: 'Test approval',
      message: 'Please respond',
      type: 'confirm',
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.mocked(api.apiFetch).mockResolvedValue({});
});

describe('ApprovalCards — number type', () => {
  it('renders a number input', () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'number' })]} />);
    expect(screen.getByRole('spinbutton')).toBeTruthy();
  });

  it('submit button is disabled when input is empty', () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'number', questionDefault: '' })]} />);
    const btn = screen.getByRole('button', { name: /submit/i });
    expect(btn).toHaveProperty('disabled', true);
  });

  it('submit button is disabled when input is NaN', () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'number' })]} />);
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: 'abc' } });
    const btn = screen.getByRole('button', { name: /submit/i });
    expect(btn).toHaveProperty('disabled', true);
  });

  it('submit button is enabled for a valid number', () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'number', questionDefault: '42' })]} />);
    const btn = screen.getByRole('button', { name: /submit/i });
    expect(btn).toHaveProperty('disabled', false);
  });

  it('submits Number value on accept', async () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'number', questionDefault: '7' })]} />);
    const btn = screen.getByRole('button', { name: /submit/i });
    fireEvent.click(btn);
    await vi.waitFor(() => {
      expect(api.apiFetch).toHaveBeenCalledWith(
        '/api/approve',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"number":7'),
        }),
      );
    });
  });
});

describe('ApprovalCards — confirm type', () => {
  it('renders Yes and No buttons', () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'confirm' })]} />);
    expect(screen.getByRole('button', { name: /yes/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /no/i })).toBeTruthy();
  });
});

describe('ApprovalCards — text type', () => {
  it('renders a text input', () => {
    render(<ApprovalCards approvals={[makeApproval({ type: 'text' })]} />);
    expect(screen.getByRole('textbox')).toBeTruthy();
  });
});
