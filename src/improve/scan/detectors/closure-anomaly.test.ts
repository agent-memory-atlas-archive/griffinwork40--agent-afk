/**
 * Tests for `improve/scan/detectors/closure-anomaly.ts`.
 *
 * Coverage:
 *   - `model_end_turn` is never detected.
 *   - Each anomalous reason produces a card (budget_exceeded, timeout,
 *     hook_blocked, abort, iteration_cap, max_turns_exceeded).
 *   - Multiple sessions sharing a reason merge into ONE detection with
 *     multiple evidence rows.
 *   - `minOccurrences` threshold honored.
 *   - Severity ladder per reason.
 *   - Slug is deterministic and matches the FailureCardSchema regex.
 *   - Evidence count is capped at MAX_EVIDENCE_PER_CARD (8).
 *   - Detail fields include affectedSessions, totalCostUsd, avgTurnCount.
 *   - DetectorResult is parseable by DetectorResultSchema.
 */

import { describe, it, expect } from 'vitest';
import { parseTraceContent, type SessionRead } from '../reader.js';
import {
  detectClosureAnomaly,
  makeSlug,
  DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES,
} from './closure-anomaly.js';
import { DetectorResultSchema, FailureCardSchema } from '../../schemas.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

let seqCounter = 0;
function resetSeq(): void {
  seqCounter = 0;
}

function closureLine(reason: string, finalCostUsd = 0, finalTurnCount = 5): string {
  return JSON.stringify({
    ts: new Date(1_700_000_000_000 + seqCounter * 1000).toISOString(),
    seq: seqCounter++,
    kind: 'closure',
    payload: {
      reason,
      finalTurnCount,
      finalCostUsd,
      finalTokens: { input: 100, output: 200 },
    },
  });
}

function makeSession(sessionId: string, lines: string[]): SessionRead {
  return parseTraceContent({
    sessionId,
    tracePath: `/abs/witness/${sessionId}/trace.jsonl`,
    relativeTracePath: `state/witness/${sessionId}/trace.jsonl`,
    content: lines.join('\n'),
    sessionMtimeMs: 1_700_000_000_000,
  });
}

/**
 * Build a `session_init_start` phase line with the given actor.
 * Used to simulate root vs subagent session identity.
 */
function sessionInitLine(actor: 'main' | 'subagent'): string {
  return JSON.stringify({
    ts: new Date(1_700_000_000_000).toISOString(),
    seq: seqCounter++,
    kind: 'session_phase',
    payload: { phase: 'session_init_start', actor },
  });
}

/**
 * Build a `session_phase` line with an arbitrary phase name (NOT
 * `session_init_start`). Used to exercise the `continue` branch in
 * `isRootSession` — the loop skips non-`session_init_start` phase events
 * and falls through to the conservative-root fallback.
 */
function phaseEventLine(phase: string): string {
  return JSON.stringify({
    ts: new Date(1_700_000_000_000).toISOString(),
    seq: seqCounter++,
    kind: 'session_phase',
    payload: { phase },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('detectClosureAnomaly — happy paths', () => {
  it('returns no results for sessions with only model_end_turn', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [closureLine('model_end_turn')]),
      makeSession('s2', [closureLine('model_end_turn')]),
    ];
    expect(detectClosureAnomaly(sessions)).toEqual([]);
  });

  it('returns no results for sessions with no closure events', () => {
    resetSeq();
    const sessions = [makeSession('s1', [])];
    expect(detectClosureAnomaly(sessions)).toEqual([]);
  });

  it('detects each of the six anomalous reasons', () => {
    const reasons = [
      'budget_exceeded',
      'timeout',
      'hook_blocked',
      'abort',
      'iteration_cap',
      'max_turns_exceeded',
    ] as const;
    for (const reason of reasons) {
      resetSeq();
      const sessions = [makeSession(`s-${reason}`, [closureLine(reason)])];
      const results = detectClosureAnomaly(sessions);
      expect(results).toHaveLength(1);
      expect(results[0]?.pattern).toBe('closure-anomaly');
      expect(results[0]?.detail['closureReason']).toBe(reason);
    }
  });

  it('merges sessions sharing a reason into one detection', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [closureLine('budget_exceeded', 1.5, 10)]),
      makeSession('s2', [closureLine('budget_exceeded', 2.0, 12)]),
      makeSession('s3', [closureLine('budget_exceeded', 0.5, 8)]),
    ];
    const results = detectClosureAnomaly(sessions);
    expect(results).toHaveLength(1);
    const r = results[0]!;
    expect(r.detail['affectedSessions']).toBe(3);
    expect(r.evidence).toHaveLength(3);
    expect(r.detail['totalCostUsd']).toBe(4); // 1.5 + 2.0 + 0.5
    expect(r.detail['avgTurnCount']).toBe(10); // (10+12+8)/3
  });

  it('produces a separate detection per distinct reason', () => {
    resetSeq();
    const sessions = [
      makeSession('s1', [closureLine('budget_exceeded')]),
      makeSession('s2', [closureLine('timeout')]),
      makeSession('s3', [closureLine('hook_blocked')]),
    ];
    const results = detectClosureAnomaly(sessions);
    expect(results).toHaveLength(3);
    const reasons = new Set(results.map((r) => r.detail['closureReason']));
    expect(reasons).toEqual(new Set(['budget_exceeded', 'timeout', 'hook_blocked']));
  });
});

describe('detectClosureAnomaly — threshold + severity', () => {
  it('honors minOccurrences', () => {
    resetSeq();
    const sessions = [makeSession('s1', [closureLine('abort')])];
    expect(detectClosureAnomaly(sessions, { minOccurrences: 1 })).toHaveLength(1);
    expect(detectClosureAnomaly(sessions, { minOccurrences: 2 })).toHaveLength(0);
  });

  it('rejects minOccurrences < 1', () => {
    expect(() => detectClosureAnomaly([], { minOccurrences: 0 })).toThrow(
      /minOccurrences must be >= 1/,
    );
  });

  it('budget_exceeded is high severity even with one occurrence', () => {
    resetSeq();
    const sessions = [makeSession('s1', [closureLine('budget_exceeded')])];
    expect(detectClosureAnomaly(sessions)[0]?.severity).toBe('high');
  });

  it('timeout is high severity even with one occurrence', () => {
    resetSeq();
    const sessions = [makeSession('s1', [closureLine('timeout')])];
    expect(detectClosureAnomaly(sessions)[0]?.severity).toBe('high');
  });

  it('hook_blocked starts medium, escalates to high at >=3', () => {
    resetSeq();
    const s1 = [makeSession('s1', [closureLine('hook_blocked')])];
    expect(detectClosureAnomaly(s1)[0]?.severity).toBe('medium');

    resetSeq();
    const s3 = [
      makeSession('a', [closureLine('hook_blocked')]),
      makeSession('b', [closureLine('hook_blocked')]),
      makeSession('c', [closureLine('hook_blocked')]),
    ];
    expect(detectClosureAnomaly(s3)[0]?.severity).toBe('high');
  });

  it('abort starts low, escalates to medium at >=3', () => {
    resetSeq();
    const s1 = [makeSession('s1', [closureLine('abort')])];
    expect(detectClosureAnomaly(s1)[0]?.severity).toBe('low');

    resetSeq();
    const s3 = [
      makeSession('a', [closureLine('abort')]),
      makeSession('b', [closureLine('abort')]),
      makeSession('c', [closureLine('abort')]),
    ];
    expect(detectClosureAnomaly(s3)[0]?.severity).toBe('medium');
  });

  it('truncated starts medium, escalates to high at >=3', () => {
    resetSeq();
    const s1 = [makeSession('s1', [closureLine('truncated')])];
    expect(detectClosureAnomaly(s1)[0]?.severity).toBe('medium');

    resetSeq();
    const s3 = [
      makeSession('a', [closureLine('truncated')]),
      makeSession('b', [closureLine('truncated')]),
      makeSession('c', [closureLine('truncated')]),
    ];
    expect(detectClosureAnomaly(s3)[0]?.severity).toBe('high');
  });
});

describe('detectClosureAnomaly — slug + schema conformance', () => {
  it('makeSlug is deterministic', () => {
    expect(makeSlug('budget_exceeded')).toBe('closure-anomaly-budget-exceeded');
    expect(makeSlug('budget_exceeded')).toBe(makeSlug('budget_exceeded'));
  });

  it('makeSlug satisfies the FailureCardSchema slug regex', () => {
    for (const r of ['budget_exceeded', 'timeout', 'hook_blocked', 'abort', 'iteration_cap', 'max_turns_exceeded']) {
      expect(makeSlug(r)).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }
  });

  it('produces a DetectorResult that parses against the schema', () => {
    resetSeq();
    const sessions = [makeSession('s1', [closureLine('budget_exceeded', 1.5, 10)])];
    const results = detectClosureAnomaly(sessions);
    expect(results).toHaveLength(1);
    const parsed = DetectorResultSchema.safeParse(results[0]);
    expect(parsed.success).toBe(true);
  });

  it('produces evidence that can be merged into a FailureCardSchema', () => {
    // Make sure the detection's evidence fits into a card without rejection.
    resetSeq();
    const sessions = [makeSession('s1', [closureLine('timeout', 0, 3)])];
    const r = detectClosureAnomaly(sessions)[0]!;
    // Construct what the writer would build for a first-sighting card.
    const card = {
      schemaVersion: 1 as const,
      slug: r.slug,
      title: r.title,
      pattern: r.pattern,
      severity: r.severity,
      status: 'open' as const,
      firstSeen: r.observedAt,
      lastSeen: r.observedAt,
      occurrenceCount: r.evidence.length,
      evidence: r.evidence,
      detail: r.detail,
      notes: [],
    };
    expect(FailureCardSchema.safeParse(card).success).toBe(true);
  });
});

describe('detectClosureAnomaly — evidence cap', () => {
  it('caps evidence at 8 rows even with 20 affected sessions', () => {
    resetSeq();
    const sessions = Array.from({ length: 20 }, (_, i) =>
      makeSession(`s-${i}`, [closureLine('budget_exceeded')]),
    );
    const r = detectClosureAnomaly(sessions)[0]!;
    expect(r.evidence).toHaveLength(8);
    // detail still records all 20.
    expect(r.detail['affectedSessions']).toBe(20);
    expect((r.detail['sessionIds'] as string[]).length).toBe(20);
  });
});

describe('default min occurrences', () => {
  it('is 1 (every anomalous closure is flagged by default)', () => {
    expect(DEFAULT_CLOSURE_ANOMALY_MIN_OCCURRENCES).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Cascade dedupe — one parent timeout must not read as N sessions.
//
// History: a single parent timeout cascade-cancels every in-flight child and
// each cancellation writes its own closure event into the SAME trace. The
// event-keyed rollup reported affectedSessions=37 / totalCostUsd=$114.47 for
// what was a much smaller set of sessions, and emitted duplicate sessionIds.
// finalCostUsd is CUMULATIVE, so summing per-event multi-counted spend.
// ---------------------------------------------------------------------------

describe('detectClosureAnomaly — cascade dedupe (per-session rollup)', () => {
  it('collapses four cascade closures in one session into a single row', () => {
    resetSeq();
    // Four children cascade-killed by one parent timeout; cost is cumulative
    // and monotonically non-decreasing across the four events.
    const sessions = [
      makeSession('parent-1', [
        closureLine('timeout', 10, 3),
        closureLine('timeout', 20, 4),
        closureLine('timeout', 30, 5),
        closureLine('timeout', 40, 6),
      ]),
    ];
    const results = detectClosureAnomaly(sessions);
    expect(results).toHaveLength(1);
    const r = results[0]!;

    // One session, not four.
    expect(r.detail['affectedSessions']).toBe(1);
    expect(r.detail['sessionIds']).toEqual(['parent-1']);

    // Evidence is per EVENT: a cascade's distinct child closures are the
    // evidence, so all four survive (codex review, PR #847).
    expect(r.evidence).toHaveLength(4);

    // Cost sums across instances. The four accumulators are disjoint — a
    // child's spend never reaches the parent's `sessionRunningCostUsd` — so
    // 10+20+30+40 IS this trace file's true spend, and the old max-based 40
    // under-reported it.
    expect(r.detail['totalCostUsd']).toBe(100);
    expect(r.detail['maxCostUsd']).toBe(40);

    // The raw event count survives as its own signal.
    expect(r.detail['closureEventCount']).toBe(4);

    // Turns average over every instance: (3+4+5+6)/4.
    expect(r.detail['avgTurnCount']).toBe(4.5);
  });

  it('never emits duplicate session ids', () => {
    resetSeq();
    const sessions = [
      makeSession('a', [closureLine('timeout', 5), closureLine('timeout', 9)]),
      makeSession('b', [closureLine('timeout', 7)]),
    ];
    const r = detectClosureAnomaly(sessions)[0]!;
    const ids = r.detail['sessionIds'] as string[];
    expect(ids).toEqual(['a', 'b']);
    expect(new Set(ids).size).toBe(ids.length);
    // Every instance's disjoint segment summed: 5+9+7, not the per-session
    // maxima 9+7 — session ids stay deduped, cost does not.
    expect(r.detail['totalCostUsd']).toBe(21);
    expect(r.detail['closureEventCount']).toBe(3);
  });

  it('counts sessions, not events, against minOccurrences', () => {
    resetSeq();
    // Three closure events but only ONE session — must not clear a 2-session bar.
    const sessions = [
      makeSession('solo', [
        closureLine('timeout', 1),
        closureLine('timeout', 2),
        closureLine('timeout', 3),
      ]),
    ];
    expect(detectClosureAnomaly(sessions, { minOccurrences: 2 })).toHaveLength(0);
    expect(detectClosureAnomaly(sessions, { minOccurrences: 1 })).toHaveLength(1);
  });

  it('reports the deduped session count in the title', () => {
    resetSeq();
    const sessions = [
      makeSession('p', [closureLine('timeout', 1), closureLine('timeout', 2)]),
    ];
    const r = detectClosureAnomaly(sessions)[0]!;
    expect(r.title).toContain('1 session');
    expect(r.title).not.toContain('2 sessions');
  });

  it('aggregates every instance regardless of event order', () => {
    resetSeq();
    // Descending cost order — nothing is discarded, so the totals are
    // order-independent and no sighting "wins".
    const sessions = [
      makeSession('p', [closureLine('timeout', 99, 12), closureLine('timeout', 4, 2)]),
    ];
    const r = detectClosureAnomaly(sessions)[0]!;
    expect(r.detail['totalCostUsd']).toBe(103);
    expect(r.detail['maxCostUsd']).toBe(99);
    expect(r.detail['avgTurnCount']).toBe(7);
    expect(r.detail['affectedSessions']).toBe(1);
  });

  it('is order-independent: reversed input yields identical aggregates', () => {
    resetSeq();
    const ascending = detectClosureAnomaly([
      makeSession('p', [closureLine('timeout', 4, 2), closureLine('timeout', 99, 12)]),
    ])[0]!;
    resetSeq();
    const descending = detectClosureAnomaly([
      makeSession('p', [closureLine('timeout', 99, 12), closureLine('timeout', 4, 2)]),
    ])[0]!;
    expect(ascending.detail['totalCostUsd']).toBe(descending.detail['totalCostUsd']);
    expect(ascending.detail['avgTurnCount']).toBe(descending.detail['avgTurnCount']);
    expect(ascending.detail['maxCostUsd']).toBe(descending.detail['maxCostUsd']);
  });

  it('still parses against DetectorResultSchema after dedupe', () => {
    resetSeq();
    const sessions = [
      makeSession('p', [closureLine('timeout', 3), closureLine('timeout', 8)]),
    ];
    const r = detectClosureAnomaly(sessions)[0]!;
    expect(DetectorResultSchema.safeParse(r).success).toBe(true);
  });

  it('caps seqs with evidence but leaves sessionIds whole', () => {
    resetSeq();
    // A wide cascade: 20 children killed by one parent timeout. Evidence and
    // seqs index each other, so both cap at 8; the aggregates and sessionIds
    // must still describe every event/session, uncapped.
    const sessions = [
      makeSession('wide', Array.from({ length: 20 }, () => closureLine('timeout', 1, 2))),
    ];
    const r = detectClosureAnomaly(sessions)[0]!;
    expect(r.evidence).toHaveLength(8);
    expect((r.detail['seqs'] as number[]).length).toBe(8);
    // Uncapped: the honest event count, the true summed spend, and the session
    // list whose length IS affectedSessions.
    expect(r.detail['closureEventCount']).toBe(20);
    expect(r.detail['totalCostUsd']).toBe(20);
    expect(r.detail['sessionIds']).toEqual(['wide']);
    expect(r.detail['affectedSessions']).toBe(1);
  });

  it('caps seqs across many sessions without truncating sessionIds', () => {
    resetSeq();
    // 12 distinct sessions — sessionIds.length must stay equal to
    // affectedSessions even though seqs is clamped to the evidence cap.
    const sessions = Array.from({ length: 12 }, (_, i) =>
      makeSession(`s${i}`, [closureLine('timeout', 1, 2)]),
    );
    const r = detectClosureAnomaly(sessions)[0]!;
    expect((r.detail['seqs'] as number[]).length).toBe(8);
    expect((r.detail['sessionIds'] as string[]).length).toBe(12);
    expect(r.detail['affectedSessions']).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Root-session scoping (issue #1919)
//
// History: the detector was counting child-abort closures inside recovered
// parent sessions, producing 156 false-positive occurrences across 29 sessions.
// The fix filters to sessions whose session_init_start carries actor:'main'.
// ---------------------------------------------------------------------------

describe('detectClosureAnomaly — root-session scoping (issue #1919)', () => {
  it('ignores closure events from subagent sessions (actor:subagent)', () => {
    resetSeq();
    const subagentSession = makeSession('child-1', [
      sessionInitLine('subagent'),
      closureLine('abort'),
    ]);
    expect(detectClosureAnomaly([subagentSession])).toEqual([]);
  });

  it('keeps closure events from root sessions (actor:main)', () => {
    resetSeq();
    const rootSession = makeSession('root-1', [
      sessionInitLine('main'),
      closureLine('abort'),
    ]);
    const results = detectClosureAnomaly([rootSession]);
    expect(results).toHaveLength(1);
    expect(results[0]?.detail['closureReason']).toBe('abort');
  });

  it('treats sessions with no session_init_start as root (conservative: old traces)', () => {
    resetSeq();
    // No session_init_start line — pre-actor trace; must not be filtered out.
    const oldSession = makeSession('old-1', [closureLine('abort')]);
    const results = detectClosureAnomaly([oldSession]);
    expect(results).toHaveLength(1);
  });

  it('correctly mixes root and subagent sessions in the same scan', () => {
    resetSeq();
    // root: abort → included; subagent: abort → excluded
    const sessions = [
      makeSession('root-a', [sessionInitLine('main'), closureLine('abort')]),
      makeSession('child-b', [sessionInitLine('subagent'), closureLine('abort')]),
      makeSession('root-c', [sessionInitLine('main'), closureLine('abort')]),
    ];
    const results = detectClosureAnomaly(sessions);
    expect(results).toHaveLength(1);
    expect(results[0]?.detail['affectedSessions']).toBe(2);
    expect(results[0]?.detail['sessionIds']).toEqual(['root-a', 'root-c']);
  });

  it('subagent session is excluded even for high-severity reasons', () => {
    resetSeq();
    const subagentSession = makeSession('child-2', [
      sessionInitLine('subagent'),
      closureLine('budget_exceeded', 50, 20),
    ]);
    expect(detectClosureAnomaly([subagentSession])).toEqual([]);
  });

  it('treats session with non-session_init_start phase events but no session_init_start as root (conservative fallback)', () => {
    // Exercises the `continue` branch in isRootSession: the loop sees a
    // session_phase event but its phase is NOT session_init_start, so it
    // continues without returning. After the loop exhausts all events with no
    // session_init_start found, isRootSession returns true (conservative root),
    // so the closure IS detected.
    resetSeq();
    const sessionWithOtherPhase = makeSession('bootstrap-only', [
      phaseEventLine('bootstrap_start'),
      closureLine('abort'),
    ]);
    const results = detectClosureAnomaly([sessionWithOtherPhase]);
    expect(results).toHaveLength(1);
    expect(results[0]?.detail['closureReason']).toBe('abort');
  });
});
