import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useScrollPin } from './use-scroll-pin';

/**
 * Build a real div with mocked read-only geometry properties.
 * scrollTop=0  → distanceFromBottom = 800 > 200 → scrolled up  → showScrollButton true
 * scrollTop=750 → distanceFromBottom = 50  ≤ 50  → pinned       → showScrollButton false
 */
function buildScrollEl(): HTMLDivElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollHeight', { get: () => 1000, configurable: true });
  Object.defineProperty(el, 'clientHeight', { get: () => 200, configurable: true });
  el.scrollTop = 750; // start near bottom
  return el;
}

function fireScroll(el: HTMLDivElement, scrollTop: number) {
  el.scrollTop = scrollTop;
  el.dispatchEvent(new Event('scroll'));
}

describe('useScrollPin — initial state', () => {
  it('starts pinned with no scroll button', () => {
    const { result } = renderHook(() => useScrollPin());
    expect(result.current.showScrollButton).toBe(false);
    expect(result.current.hasNewContent).toBe(false);
    expect(result.current.isPinned).toBe(true);
  });

  it('notifyNewContent does not arm hasNewContent when already at bottom (scrolledUpRef=false)', () => {
    const { result } = renderHook(() => useScrollPin());
    act(() => { result.current.notifyNewContent(); });
    expect(result.current.hasNewContent).toBe(false);
    expect(result.current.showScrollButton).toBe(false);
  });
});

describe('useScrollPin — regression: jump button missing on finished transcript (D4 bug)', () => {
  /**
   * Invariant: showScrollButton must be true whenever the user is scrolled up,
   * regardless of whether new content has arrived.
   *
   * D4 had: showScrollButton = hasNewContent && scrolledUp — this hid the button
   * when reading history with no new content, leaving no way back to the bottom.
   * Fix: showScrollButton = isScrolledUp (always visible when far from bottom).
   */
  it('showScrollButton is true when scrolled up through finished transcript (no notifyNewContent)', () => {
    const el = buildScrollEl();
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const pin = useScrollPin();
      // Seed ref synchronously during render so the effect's addEventListener fires on el.
      if (!pin.containerRef.current) pin.containerRef.current = el;
      return pin;
    });

    // Start pinned near bottom — no button.
    act(() => { fireScroll(el, 750); });
    expect(result.current.showScrollButton).toBe(false);
    expect(result.current.isPinned).toBe(true);

    // Scroll to top (distanceFromBottom=800 > 200): button must appear without new content.
    act(() => { fireScroll(el, 0); });
    expect(result.current.showScrollButton).toBe(true);
    expect(result.current.hasNewContent).toBe(false); // no notifyNewContent called

    // scrollToBottom clears state.
    act(() => {
      result.current.scrollToBottom();
      fireScroll(el, 750);
    });
    expect(result.current.showScrollButton).toBe(false);

    document.body.removeChild(el);
  });

  it('hasNewContent becomes true ("New messages" label) when notifyNewContent called while scrolled up', () => {
    const el = buildScrollEl();
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const pin = useScrollPin();
      if (!pin.containerRef.current) pin.containerRef.current = el;
      return pin;
    });

    // Scroll up first.
    act(() => { fireScroll(el, 0); });
    expect(result.current.showScrollButton).toBe(true);
    expect(result.current.hasNewContent).toBe(false);

    // New content arrives while scrolled up → "New messages" label.
    act(() => { result.current.notifyNewContent(); });
    expect(result.current.hasNewContent).toBe(true);
    expect(result.current.showScrollButton).toBe(true);

    // Scroll back to bottom → both flags clear.
    act(() => { fireScroll(el, 750); });
    expect(result.current.hasNewContent).toBe(false);
    expect(result.current.showScrollButton).toBe(false);
    expect(result.current.isPinned).toBe(true);

    document.body.removeChild(el);
  });

  it('notifyNewContent does NOT arm hasNewContent when pinned (at bottom)', () => {
    const el = buildScrollEl();
    document.body.appendChild(el);

    const { result } = renderHook(() => {
      const pin = useScrollPin();
      if (!pin.containerRef.current) pin.containerRef.current = el;
      return pin;
    });

    // Fire a pinned scroll event first (scrollTop=750 → distanceFromBottom=50 ≤ 50).
    act(() => { fireScroll(el, 750); });
    expect(result.current.showScrollButton).toBe(false);

    // notifyNewContent while pinned must not arm content.
    act(() => { result.current.notifyNewContent(); });
    expect(result.current.hasNewContent).toBe(false);

    document.body.removeChild(el);
  });
});
