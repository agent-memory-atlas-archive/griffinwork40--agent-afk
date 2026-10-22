import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TranscriptView } from './transcript-view';
import type { TranscriptItem } from '@/lib/ledger-adapter';

const initialItems: TranscriptItem[] = [
  { kind: 'user', id: 'user', text: 'Question' },
  { kind: 'thinking', id: 'thinking', text: 'Original reasoning' },
  { kind: 'assistant', id: 'assistant', text: 'Answer' },
];

describe.each([true, false])('thinking display (spineMode=%s)', (spineMode) => {
  it('hides old and incoming thinking when off and restores both without modifying data', () => {
    const items = initialItems.map((item) => Object.freeze({ ...item }));
    const { rerender } = render(<TranscriptView items={items} spineMode={spineMode} />);
    expect(screen.getByText('Original reasoning')).toBeTruthy();
    rerender(<TranscriptView items={items} spineMode={spineMode} thinkingUi="off" />);
    expect(screen.queryByText('Original reasoning')).toBeNull();
    expect(screen.getByText('Answer')).toBeTruthy();
    expect(screen.getByText('Question')).toBeTruthy();

    const incoming: TranscriptItem[] = [...items, { kind: 'thinking', id: 'new', text: 'Incoming reasoning' }];
    rerender(<TranscriptView items={incoming} spineMode={spineMode} thinkingUi="off" />);
    expect(screen.queryByText('Incoming reasoning')).toBeNull();
    rerender(<TranscriptView items={incoming} spineMode={spineMode} thinkingUi="live" />);
    expect(screen.getByText('Original reasoning')).toBeTruthy();
    expect(screen.getByText('Incoming reasoning')).toBeTruthy();
    expect(items).toEqual(initialItems);
    expect(incoming).toHaveLength(4);
  });

  it.each(['summary', 'digest'] as const)('keeps thinking available in %s mode', (thinkingUi) => {
    render(<TranscriptView items={initialItems} spineMode={spineMode} thinkingUi={thinkingUi} />);
    expect(screen.getByText('Original reasoning')).toBeTruthy();
  });
});

describe('workingState (indicator visibility + phase)', () => {
  it('keeps the indicator while the streaming draft has no visible text, hides it once text shows', async () => {
    const { workingState } = await import('./transcript-view');
    const user = { kind: 'user' as const, id: 'u', text: 'q' };
    const empty = { kind: 'assistant' as const, id: 'd', text: '', live: 'streaming' };
    const fence = { kind: 'assistant' as const, id: 'd', text: '```ty', live: 'streaming' };
    const shown = { kind: 'assistant' as const, id: 'd', text: 'Hello', live: 'streaming' };
    expect(workingState([user, empty], true).showWorking).toBe(true);
    expect(workingState([user, fence], true).showWorking).toBe(true);
    expect(workingState([user, shown], true).showWorking).toBe(false);
  });

  it('reports Running <tool> while the newest tool has no result, then Writing', async () => {
    const { workingState } = await import('./transcript-view');
    const user = { kind: 'user' as const, id: 'u', text: 'q' };
    const tool = { kind: 'tool' as const, id: 't', name: 'bash', inputPreview: 'sleep 4', status: 'running' as const };
    expect(workingState([user, tool], true)).toMatchObject({ showWorking: true, workingPhase: 'running', runningTool: 'bash' });
    expect(workingState([user, { ...tool, status: 'ok' as const }], true)).toMatchObject({ workingPhase: 'writing' });
  });

  it('renders "Running bash" in the indicator', async () => {
    const { TranscriptView: View } = await import('./transcript-view');
    const { render: r } = await import('@testing-library/react');
    const { container } = r(<View turnActive items={[{ kind: 'user', id: 'u', text: 'q' }, { kind: 'tool', id: 't', name: 'bash', inputPreview: 'sleep 4', status: 'running' }]} />);
    expect(container.querySelector('[data-testid="working-indicator"]')?.textContent).toContain('Running bash');
  });
});
