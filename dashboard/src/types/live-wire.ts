/**
 * Browser-safe mirror of src/web-server/shared/live-wire.ts. Keep in sync.
 *
 * Live frames are id-less SSE frames, never ledger records: `seg` matches the
 * `seg` of the durable assistant/thinking record that later replaces the draft.
 */
export type LivePart = 'text' | 'thinking';

export type LiveSsePayload =
  | { type: 'live_snapshot'; seg: number; part: LivePart; text: string }
  | { type: 'live_delta'; seg: number; part: LivePart; offset: number; text: string }
  | { type: 'live_seal'; seg: number; part: LivePart }
  | { type: 'live_end'; reason: 'done' | 'error' | 'aborted' };

/** Client-only: the connection was reset/reconnected; drafts must be rebuilt from the next snapshot. */
export type LiveClientEvent = LiveSsePayload | { type: 'live_reset' };

export function isLivePayload(value: unknown): value is LiveSsePayload {
  return typeof value === 'object' && value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    (value as { type: string }).type.startsWith('live_');
}
