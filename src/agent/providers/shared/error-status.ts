/**
 * Shared HTTP-status extractor for provider retry predicates.
 *
 * Both the Anthropic-direct and OpenAI-compatible providers classify errors
 * as retryable or fatal by inspecting the HTTP status code on the thrown SDK
 * error. The extraction logic is identical — the SDK always places `status` at
 * the top level of the error object — but the *retryable status-code sets*
 * differ per provider (see each provider's own retry module).
 *
 * Extracting only the status-extraction helper lets each provider keep its own
 * set while sharing the field-access logic that would otherwise be duplicated.
 *
 * @module agent/providers/shared/error-status
 */

/**
 * Extract an HTTP status code from a thrown SDK error (Anthropic or OpenAI
 * compatible). Both SDKs set a numeric `status` field on their `APIError`
 * subclasses; network errors and generic throws have no `status` and return
 * `undefined`.
 *
 * Each provider keeps its own retryable-status-code set and consults this
 * helper solely to retrieve the raw status before applying its own predicate.
 */
export function getErrorStatus(err: unknown): number | undefined {
  if (err === null || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown };
  return typeof e.status === 'number' ? e.status : undefined;
}
