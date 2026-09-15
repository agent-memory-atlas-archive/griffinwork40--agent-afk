/**
 * Unit tests for spine-store.ts — parse/serialize round-trip and ID generation.
 *
 * These tests are pure functions with no I/O — no temp directories needed.
 */

import { describe, expect, it } from 'vitest';
import {
  parseSpine,
  serializeSpine,
  nextId,
  addEntry,
  findEntry,
} from './spine-store.js';
import type { SpineDocument } from './spine-store.js';

// ── helpers ──────────────────────────────────────────────────────────────────

function makeDoc(): SpineDocument {
  return {
    sections: [
      { name: 'Invariants', prefix: 'INV', entries: [] },
      { name: 'Explicitly Rejected Patterns', prefix: 'REJ', entries: [] },
      { name: 'Taste Calls Made', prefix: 'TST', entries: [] },
    ],
    trailer: '',
  };
}

// ── parseSpine ────────────────────────────────────────────────────────────────

describe('parseSpine', () => {
  it('returns empty sections for a skeleton SPINE.md', () => {
    const content = [
      '# SPINE.md — Project Architecture Spine',
      '',
      '## Invariants',
      '_(none yet)_',
      '',
      '## Explicitly Rejected Patterns',
      '_(none yet)_',
      '',
      '## Taste Calls Made',
      '_(none yet)_',
    ].join('\n');

    const doc = parseSpine(content);
    expect(doc.sections).toHaveLength(3);
    expect(doc.sections[0].name).toBe('Invariants');
    expect(doc.sections[0].entries).toHaveLength(0);
    expect(doc.sections[1].name).toBe('Explicitly Rejected Patterns');
    expect(doc.sections[2].name).toBe('Taste Calls Made');
  });

  it('parses entries with all required fields', () => {
    const content = [
      '## Invariants',
      '',
      '- **INV-001** (2026-09-12, session-abc): All env vars go through env.ts',
      '- **INV-002** (2026-09-13, session-def): Files capped at 350 LOC',
      '',
      '## Explicitly Rejected Patterns',
      '',
      '- **REJ-001** (2026-09-12, session-abc): No raw process.env access',
      '',
      '## Taste Calls Made',
    ].join('\n');

    const doc = parseSpine(content);
    const inv = doc.sections.find((s) => s.name === 'Invariants')!;
    expect(inv.entries).toHaveLength(2);
    expect(inv.entries[0]).toEqual({
      id: 'INV-001',
      date: '2026-09-12',
      sessionId: 'session-abc',
      description: 'All env vars go through env.ts',
    });
    expect(inv.entries[1].id).toBe('INV-002');

    const rej = doc.sections.find((s) => s.name === 'Explicitly Rejected Patterns')!;
    expect(rej.entries).toHaveLength(1);
    expect(rej.entries[0].id).toBe('REJ-001');
  });

  it('ignores unknown headings in trailer', () => {
    const content = [
      '## Invariants',
      '## Unknown Section',
      'some content',
    ].join('\n');
    const doc = parseSpine(content);
    expect(doc.trailer).toContain('Unknown Section');
  });
});

// ── serializeSpine ────────────────────────────────────────────────────────────

describe('serializeSpine', () => {
  it('produces the SPINE.md header', () => {
    const doc = makeDoc();
    const output = serializeSpine(doc);
    expect(output).toContain('# SPINE.md');
    expect(output).toContain('Auto-maintained');
  });

  it('renders "none yet" for empty sections', () => {
    const doc = makeDoc();
    const output = serializeSpine(doc);
    expect(output).toContain('_(none yet)_');
  });

  it('round-trips a document with entries', () => {
    const doc = makeDoc();
    doc.sections[0].entries.push({
      id: 'INV-001',
      date: '2026-09-12',
      sessionId: 'session-abc',
      description: 'All env vars go through env.ts',
    });

    const serialized = serializeSpine(doc);
    const reparsed = parseSpine(serialized);

    const inv = reparsed.sections.find((s) => s.name === 'Invariants')!;
    expect(inv.entries).toHaveLength(1);
    expect(inv.entries[0]).toEqual({
      id: 'INV-001',
      date: '2026-09-12',
      sessionId: 'session-abc',
      description: 'All env vars go through env.ts',
    });
  });

  it('round-trips multiple sections', () => {
    const doc = makeDoc();
    doc.sections[0].entries.push({
      id: 'INV-001',
      date: '2026-09-12',
      sessionId: 's1',
      description: 'Invariant one',
    });
    doc.sections[1].entries.push({
      id: 'REJ-001',
      date: '2026-09-12',
      sessionId: 's2',
      description: 'Rejected pattern one',
    });
    doc.sections[2].entries.push({
      id: 'TST-001',
      date: '2026-09-12',
      sessionId: 's3',
      description: 'Taste call one',
    });

    const reparsed = parseSpine(serializeSpine(doc));

    expect(reparsed.sections[0].entries[0].id).toBe('INV-001');
    expect(reparsed.sections[1].entries[0].id).toBe('REJ-001');
    expect(reparsed.sections[2].entries[0].id).toBe('TST-001');
  });
});

// ── nextId ────────────────────────────────────────────────────────────────────

describe('nextId', () => {
  it('returns INV-001 for an empty document', () => {
    const doc = makeDoc();
    expect(nextId(doc, 'INV')).toBe('INV-001');
  });

  it('increments past the highest existing ID', () => {
    const doc = makeDoc();
    doc.sections[0].entries.push(
      { id: 'INV-001', date: '2026-09-12', sessionId: 's', description: 'd' },
      { id: 'INV-003', date: '2026-09-12', sessionId: 's', description: 'd' },
    );
    expect(nextId(doc, 'INV')).toBe('INV-004');
  });

  it('zero-pads to 3 digits', () => {
    const doc = makeDoc();
    expect(nextId(doc, 'REJ')).toBe('REJ-001');
    expect(nextId(doc, 'TST')).toBe('TST-001');
  });

  it('scans all sections for collisions', () => {
    // INV prefix entries are only in section[0], but this tests the scan
    const doc = makeDoc();
    doc.sections[0].entries.push(
      { id: 'INV-005', date: '2026-09-12', sessionId: 's', description: 'd' },
    );
    expect(nextId(doc, 'INV')).toBe('INV-006');
    // REJ has none
    expect(nextId(doc, 'REJ')).toBe('REJ-001');
  });
});

// ── addEntry ──────────────────────────────────────────────────────────────────

describe('addEntry', () => {
  it('adds to the correct section and returns the generated ID', () => {
    const doc = makeDoc();
    const id = addEntry(doc, 'INV', 'session-test', 'Test invariant', '2026-09-12');
    expect(id).toBe('INV-001');
    const inv = doc.sections.find((s) => s.prefix === 'INV')!;
    expect(inv.entries).toHaveLength(1);
    expect(inv.entries[0]).toEqual({
      id: 'INV-001',
      date: '2026-09-12',
      sessionId: 'session-test',
      description: 'Test invariant',
    });
  });

  it('auto-generates today ISO date when date is omitted', () => {
    const doc = makeDoc();
    addEntry(doc, 'REJ', 'session-test', 'Rejected pattern');
    const rej = doc.sections.find((s) => s.prefix === 'REJ')!;
    expect(rej.entries[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('generates sequential IDs across multiple calls', () => {
    const doc = makeDoc();
    const id1 = addEntry(doc, 'TST', 's', 'First');
    const id2 = addEntry(doc, 'TST', 's', 'Second');
    expect(id1).toBe('TST-001');
    expect(id2).toBe('TST-002');
  });
});

// ── findEntry ─────────────────────────────────────────────────────────────────

describe('findEntry', () => {
  it('finds an entry by ID across sections', () => {
    const doc = makeDoc();
    addEntry(doc, 'INV', 's', 'Invariant one');
    addEntry(doc, 'REJ', 's', 'Rejected one');
    addEntry(doc, 'TST', 's', 'Taste call one');

    expect(findEntry(doc, 'INV-001')?.description).toBe('Invariant one');
    expect(findEntry(doc, 'REJ-001')?.description).toBe('Rejected one');
    expect(findEntry(doc, 'TST-001')?.description).toBe('Taste call one');
  });

  it('returns undefined for a non-existent ID', () => {
    const doc = makeDoc();
    expect(findEntry(doc, 'INV-999')).toBeUndefined();
  });
});
