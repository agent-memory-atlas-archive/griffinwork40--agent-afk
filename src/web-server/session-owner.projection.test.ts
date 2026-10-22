import { describe, expect, it } from 'vitest';
import { projectJournalMessages } from './session-owner.projection.js';

describe('projectJournalMessages (rewind projection)', () => {
  it('keeps a 20k assistant answer whole and still clips user text', () => {
    const answer = 'b'.repeat(20_000);
    const records = projectJournalMessages([
      { role: 'user', content: [{ type: 'text', text: 'q'.repeat(20_000) }] },
      { role: 'assistant', content: [{ type: 'text', text: answer }] },
    ] as never);
    expect(records.find((r) => r.kind === 'assistant')).toEqual({ kind: 'assistant', text: answer });
    const user = records.find((r) => r.kind === 'user');
    expect(user?.kind === 'user' && user.text.length).toBeLessThan(8_100);
  });
});
