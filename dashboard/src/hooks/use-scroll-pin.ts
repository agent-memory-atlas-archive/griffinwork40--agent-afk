/**
 * Scroll-to-bottom pinning hook.
 *
 * Attaches to a scrollable container ref. When the user is scrolled within
 * PINNED_THRESHOLD_PX of the bottom, new content triggers an automatic scroll.
 * When the user has scrolled up, auto-scroll is suppressed until they return
 * to the bottom.
 *
 * Contract: attach `containerRef` to the element that has `overflow-y: auto`
 * (or `scroll`). Call `scrollToBottom()` whenever new items are added — the
 * hook decides whether to act based on the current pin state.
 *
 * Invariant: `showScrollButton` is true ONLY when the user is scrolled far
 * enough up AND new content has arrived since they left the bottom. Scrolling
 * up without new content (e.g. reading history) does not show the pill.
 * Scrolling to the bottom clears the new-content flag and hides the pill.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const PINNED_THRESHOLD_PX = 50;

/** Distance from bottom beyond which the pill can appear (if new content). */
const SHOW_BUTTON_THRESHOLD_PX = 200;

export interface UseScrollPinResult {
  /** Attach this to the scrollable container element. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Scroll to the bottom of the container. Always works, regardless of pin state. */
  scrollToBottom: () => void;
  /** Whether the container is currently pinned to the bottom. */
  isPinned: boolean;
  /**
   * True when the user is scrolled up AND new content has arrived since they
   * left the bottom. Cleared when the user scrolls back to the bottom.
   */
  showScrollButton: boolean;
  /**
   * Call whenever new content is appended. If the user is currently scrolled
   * up, this arms the pill so it becomes visible.
   */
  notifyNewContent: () => void;
}

export function useScrollPin(): UseScrollPinResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPinned, setIsPinned] = useState(true);
  // True only when new content arrived while the user was scrolled up.
  const [hasNewContent, setHasNewContent] = useState(false);
  // True when the user is far enough from the bottom (independent of new content).
  const scrolledUpRef = useRef(false);

  // Track pin state and button visibility on scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    function handleScroll(): void {
      if (el === null) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const pinned = distanceFromBottom <= PINNED_THRESHOLD_PX;
      scrolledUpRef.current = distanceFromBottom > SHOW_BUTTON_THRESHOLD_PX;
      setIsPinned(pinned);
      // Clear the new-content flag when user returns near the bottom.
      if (pinned) setHasNewContent(false);
    }

    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = containerRef.current;
    if (el === null) return;
    el.scrollTop = el.scrollHeight;
    setHasNewContent(false);
  }, []);

  const notifyNewContent = useCallback(() => {
    // Only arm the pill if the user is actually scrolled up.
    if (scrolledUpRef.current) setHasNewContent(true);
  }, []);

  const showScrollButton = hasNewContent && scrolledUpRef.current;

  return { containerRef, scrollToBottom, isPinned, showScrollButton, notifyNewContent };
}
