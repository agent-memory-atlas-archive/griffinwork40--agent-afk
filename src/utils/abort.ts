/**
 * AbortSignal forwarding utilities.
 *
 * @module utils/abort
 */

/**
 * Forward an abort from a parent signal to a child AbortController.
 * Returns a cleanup function that removes the listener.
 */
export function forwardAbortSignal(
  parent: AbortSignal,
  child: AbortController,
): () => void {
  if (parent.aborted) {
    child.abort(parent.reason);
    return () => {};
  }
  const handler = () => child.abort(parent.reason);
  parent.addEventListener('abort', handler, { once: true });
  return () => parent.removeEventListener('abort', handler);
}
