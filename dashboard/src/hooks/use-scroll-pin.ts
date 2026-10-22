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
 * Invariant: `showScrollButton` is true whenever the user is scrolled far
 * enough up (best-in-class: always show ↓ so the user can get back). The
 * `hasNewContent` flag is layered on top: the label expands to "New messages"
 * only when content arrived while the user was scrolled up. Scrolling to the
 * bottom clears both flags and hides the pill.
 *
 * History: D4 set showScrollButton = hasNewContent && scrolledUp, which hid
 * the button when the user scrolled up through a FINISHED answer with no new
 * content arriving — no way back to the bottom without manual scroll. Fix:
 * expose `isScrolledUp` separately; the pill is always visible when scrolled
 * up, and the label "New messages" is added only when hasNewContent is true.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const PINNED_THRESHOLD_PX = 50;

/** Distance from bottom beyond which the jump button appears. */
const SHOW_BUTTON_THRESHOLD_PX = 200;

export interface UseScrollPinResult {
  /** Attach this to the scrollable container element. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Scroll to the bottom of the container. Always works, regardless of pin state. */
  scrollToBottom: () => void;
  /** Whether the container is currently pinned to the bottom. */
  isPinned: boolean;
  /**
   * True whenever the user is scrolled far enough up (≥ SHOW_BUTTON_THRESHOLD_PX
   * from the bottom). The jump button is visible whenever this is true.
   */
  showScrollButton: boolean;
  /**
   * True when the user is scrolled up AND new content has arrived since they
   * left the bottom. Cleared when the user scrolls back to the bottom.
   * Use to expand the button label to "New messages".
   */
  hasNewContent: boolean;
  /**
   * Call whenever new content is appended. If the user is currently scrolled
   * up, this arms the "New messages" label.
   */
  notifyNewContent: () => void;
}

export function useScrollPin(): UseScrollPinResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [isPinned, setIsPinned] = useState(true);
  // True when the user is far enough from the bottom.
  const [isScrolledUp, setIsScrolledUp] = useState(false);
  // True only when new content arrived while the user was scrolled up.
  const [hasNewContent, setHasNewContent] = useState(false);
  // Ref mirror of isScrolledUp for use inside notifyNewContent callback.
  const scrolledUpRef = useRef(false);

  // Track pin state and button visibility on scroll.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;

    function handleScroll(): void {
      if (el === null) return;
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      const pinned = distanceFromBottom <= PINNED_THRESHOLD_PX;
      const scrolledUp = distanceFromBottom > SHOW_BUTTON_THRESHOLD_PX;
      scrolledUpRef.current = scrolledUp;
      setIsPinned(pinned);
      setIsScrolledUp(scrolledUp);
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
    // Only arm the "New messages" label if the user is actually scrolled up.
    if (scrolledUpRef.current) setHasNewContent(true);
  }, []);

  return { containerRef, scrollToBottom, isPinned, showScrollButton: isScrolledUp, hasNewContent, notifyNewContent };
}
