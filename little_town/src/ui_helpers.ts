// Position-after-mount helpers used by the various contextual popovers
// (NPC action menus, label/destination pickers, etc).
//
// All popovers default to anchoring below their trigger / click point,
// but that clips off-screen when the trigger is near the bottom edge
// (or off the right edge for very wide menus). After appending to the
// DOM we measure the actual rendered size in the next animation frame
// and shift / flip / clamp the popover so it stays fully visible.

export interface ClampOpts {
  margin?: number;   // safe distance from viewport edges (default 8)
  // For "open below anchor" flows: when the popover doesn't fit
  // below, try positioning ABOVE this rect instead of just clamping
  // to the bottom edge. Pass the anchor element's DOMRect.
  flipAboveAnchor?: DOMRect;
}

// Reposition `pop` so its rendered rect stays within the viewport.
// Reads style.left / style.top as the DESIRED position; rewrites both
// if needed. Run after the element is in the document. Re-runs
// automatically when the popup's content size changes (e.g. async
// avatar image loads, lazy-fetched rule list arrives) so the popup is
// never left clipping the viewport edge.
export function clampPopupToViewport(pop: HTMLElement, opts: ClampOpts = {}): void {
  const margin = opts.margin ?? 8;
  const place = () => {
    const r = pop.getBoundingClientRect();
    let top = r.top;
    let left = r.left;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Vertical: try the original spot first, then flip above the anchor
    // if requested, then fall back to clamping to the bottom edge.
    if (top + r.height > vh - margin) {
      let placed = false;
      if (opts.flipAboveAnchor) {
        const aboveTop = opts.flipAboveAnchor.top - r.height - 6;
        if (aboveTop >= margin) {
          top = aboveTop;
          placed = true;
        }
      }
      if (!placed) {
        top = Math.max(margin, vh - r.height - margin);
      }
    }
    if (top < margin) top = margin;

    if (left + r.width > vw - margin) {
      left = Math.max(margin, vw - r.width - margin);
    }
    if (left < margin) left = margin;

    pop.style.top = `${top}px`;
    pop.style.left = `${left}px`;
    // Always cap max-height to the available space from the placed top
    // to the bottom margin. This is authoritative — even if the caller
    // set max-height (e.g. 80vh), we override it when the placed
    // position leaves less room, so the popup will scroll internally
    // instead of clipping off-screen.
    const maxH = Math.max(60, vh - top - margin);
    pop.style.maxHeight = `${maxH}px`;
    // Ensure overflow:auto so the capped height actually scrolls. Don't
    // stomp on `hidden` (some popups manage their own inner scrolling).
    if (pop.style.overflow !== 'hidden' && pop.style.overflowY !== 'hidden') {
      pop.style.overflow = 'auto';
    }
    // Cap max-width the same way for completeness.
    const maxW = Math.max(120, vw - left - margin);
    pop.style.maxWidth = `${maxW}px`;
  };
  // Initial placement after one frame so flex/grid layout has settled.
  requestAnimationFrame(place);
  // Re-clamp whenever the popup's content size changes — covers
  // async-loaded avatars, lazy-fetched rule lists, etc. We stop
  // observing automatically when the popup leaves the DOM.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => place());
    ro.observe(pop);
    const mo = new MutationObserver(() => {
      if (!pop.isConnected) {
        ro.disconnect();
        mo.disconnect();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  // Re-clamp on window resize so it stays valid as the user resizes.
  const onResize = () => {
    if (!pop.isConnected) {
      window.removeEventListener('resize', onResize);
      return;
    }
    place();
  };
  window.addEventListener('resize', onResize);
}
