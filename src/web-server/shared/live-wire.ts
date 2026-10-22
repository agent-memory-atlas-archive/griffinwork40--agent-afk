/**
 * Browser-safe ephemeral live-text wire (mirrored in dashboard/src/types/live-wire.ts).
 *
 * Live frames are id-less SSE frames: they never advance the durable ledger
 * cursor and are never written to the ledger. `seg` matches the `seg` of the
 * durable `assistant` / `thinking` record that later replaces the draft (both
 * numbered by `SegmentTracker`). `offset` is the draft length before `text`,
 * so a client drops duplicates and detects gaps (then waits for a snapshot).
 */
export type LivePart = 'text' | 'thinking';

export type LiveSsePayload =
  | { type: 'live_snapshot'; seg: number; part: LivePart; text: string }
  | { type: 'live_delta'; seg: number; part: LivePart; offset: number; text: string }
  | { type: 'live_seal'; seg: number; part: LivePart }
  | { type: 'live_end'; reason: 'done' | 'error' | 'aborted' };
