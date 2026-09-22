/**
 * Shared base for the per-provider tracing-fetch wrappers.
 *
 * Both the Anthropic-direct and OpenAI-compatible providers wrap the SDK's
 * `fetch` option with the same gate → baseFetch → onRateLimit → freeze →
 * onThrottle state machine. The only per-provider differences are:
 *   - Anthropic adds `onQuota` (unified rate-limit header capture) and a
 *     witness-trace emit on throttled responses.
 *   - OpenAI omits both.
 *
 * {@link makeBaseTracingFetch} implements the shared core. Each provider's own
 * `makeTracingFetch` / `makeOpenAITracingFetch` calls this and layers its
 * provider-specific arms on top (or uses it directly for the OpenAI case, which
 * has no extra arms).
 *
 * @module agent/providers/shared/tracing-fetch
 */

import { estimateInputTokens } from './rate-limit-bucket.js';
import { parseRetryAfterMs } from './retry-after.js';
import { THROTTLE_STATUSES } from './tracing-fetch-utils.js';
import type { ThrottleInfo, RateLimitGate } from './tracing-fetch-utils.js';

// Re-export for convenience so provider files can import types from one place.
export type { ThrottleInfo, RateLimitGate };

/**
 * Parameters for the shared base tracing-fetch wrapper.
 *
 * Every field is optional so callers can pass only what they need; the factory
 * short-circuits to `baseFetch` unchanged when all fields are absent.
 */
export interface BaseTracingFetchOptions {
  /** The real `fetch` implementation (or a test stub). Defaults to global `fetch`. */
  baseFetch?: typeof fetch;
  /**
   * Admission gate — wait for a permit BEFORE the outbound HTTP call. When
   * provided, a 429 response also triggers `gate.freeze` with the server-advised
   * retry delay so concurrent waiters back off together.
   */
  gate?: RateLimitGate;
  /**
   * Fired on EVERY response so the rate-limit bucket stays current after each
   * round-trip. Guarded with try/catch — a broken observer never disturbs the
   * request path.
   */
  onRateLimit?: (headers: Headers) => void;
  /**
   * Fired on 429/503/529 responses for live-surface updates (e.g. progress
   * banner). Guarded with try/catch — a throwing callback never disturbs the
   * SDK retry loop.
   */
  onThrottle?: (info: ThrottleInfo) => void;
}

/**
 * Wrap a `fetch` implementation with the shared gate/throttle/freeze state
 * machine. Returns `baseFetch` (or global `fetch`) unchanged when no options
 * are provided — zero overhead on the happy path.
 *
 * Execution order on every request:
 *  1. `gate.acquirePermit` — wait for an admission slot (skipped when absent).
 *  2. `baseFetch` — the real outbound HTTP call.
 *  3. `onRateLimit(res.headers)` — unconditional header capture.
 *  4. `gate.freeze` — back off concurrent waiters on 429.
 *  5. `onThrottle` — live signal for throttled responses (429/503/529).
 *
 * Provider-specific arms (Anthropic: `onQuota`, trace emit) are added by the
 * caller after receiving the wrapped fetch or by composing a second layer on top.
 */
export function makeBaseTracingFetch(opts: BaseTracingFetchOptions = {}): typeof fetch {
  const { gate, onRateLimit, onThrottle } = opts;
  const baseFetch = opts.baseFetch ?? fetch;

  if (!gate && !onRateLimit && !onThrottle) return baseFetch;

  return async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    // ADMISSION GATE: wait for a permit before the outbound request.
    // Called BEFORE baseFetch so the request waits in the wrapper, not after
    // committing to an HTTP round-trip that will immediately 429.
    if (gate) {
      const estimated = estimateInputTokens(init);
      const signal = init?.signal instanceof AbortSignal ? init.signal : undefined;
      await gate.acquirePermit(estimated, signal);
    }

    const res = await baseFetch(input, init);

    // Per-minute header capture: runs unconditionally so the bucket stays
    // current after every response, not just throttled ones. Guarded so a
    // broken observer never disturbs the SDK retry loop.
    if (onRateLimit) {
      try {
        onRateLimit(res.headers);
      } catch {
        // A broken observer must never disturb the SDK retry loop.
      }
    }

    // Hard-freeze the bucket on 429 so concurrent waiters in acquirePermit
    // also back off. Uses the shared parseRetryAfterMs which checks
    // retry-after-ms (ms) first, then retry-after (seconds).
    if (gate && res.status === 429) {
      try {
        const retryMs = parseRetryAfterMs({ headers: res.headers });
        gate.freeze(retryMs ?? 5_000);
      } catch {
        // ignore
      }
    }

    // Live throttle signal for the progress banner.
    if (onThrottle && THROTTLE_STATUSES.has(res.status)) {
      try {
        const retryAfterMs = parseRetryAfterMs({ headers: res.headers });
        onThrottle({
          status: res.status,
          ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        });
      } catch {
        // A broken observer must never disturb the SDK retry loop.
      }
    }

    return res;
  };
}
