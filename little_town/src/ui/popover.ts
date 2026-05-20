// Town Inbox — reusable popover primitive.
//
// Replaces the 7+ hand-rolled `setTimeout(... document.addEventListener(
// 'mousedown', away, true))` patterns scattered across main.ts,
// email_ui.ts, email_content.ts, people_ui.ts. Every one of those was
// individually buggy in subtle ways:
//
//   - Phase G C6: clicking a destination called pop.remove() but left
//     the document-scoped `away` listener orphaned forever. Fixed
//     per-callsite by overriding pop.remove(), but the fix was
//     mechanical and error-prone — easy to forget the next time
//     someone copy-pastes the pattern.
//
//   - The popover's content was always responsible for its own search
//     input, list rendering, scroll, hover styles, and dismissal
//     plumbing. ~80 lines per callsite of which ~50 were boilerplate.
//
// `openPopover(...)` returns a tiny handle whose `.close()` is the
// only correct way to dismiss it. It guarantees:
//   * the popover element is removed from the DOM
//   * the document-scoped dismissal listener is removed
//   * the caller's `onClose` callback fires exactly once
//   * Escape and click-outside both dismiss
//   * positioning is clamped to the viewport (via existing helper)

import { clampPopupToViewport } from '../ui_helpers';

export interface PopoverOpts {
  /** Element the popover should be positioned near. */
  anchor: HTMLElement;
  /** The popover's content. Will be appended to a fresh wrapper div. */
  content: HTMLElement;
  /** Fired once after the popover is detached. */
  onClose?: () => void;
  /** Width in pixels (default 320). */
  width?: number;
  /** Max height as a viewport-height unit (default '60vh'). */
  maxHeight?: string;
  /** Z-index for the wrapper (default 1300 — above modals). */
  zIndex?: number;
  /** Extra CSS to apply on top of the dark-theme defaults. */
  extraStyle?: string;
  /** data-* attribute name (without "data-" prefix) for de-dup with old siblings. */
  dataAttr?: string;
}

export interface PopoverHandle {
  /** The wrapper element — caller can append additional content here. */
  el: HTMLDivElement;
  /** Tear down: remove from DOM, detach listeners, fire onClose. Idempotent. */
  close(): void;
}

export function openPopover(opts: PopoverOpts): PopoverHandle {
  // If the caller specified a data-attr, blow away any previous
  // popover sharing it. Matches the existing pattern
  // `document.querySelectorAll('[data-quick-move]').forEach(el => el.remove())`.
  if (opts.dataAttr) {
    document.querySelectorAll(`[data-${opts.dataAttr}]`).forEach(el => el.remove());
  }

  const rect = opts.anchor.getBoundingClientRect();
  const width = opts.width ?? 320;
  const maxHeight = opts.maxHeight ?? '60vh';
  const zIndex = opts.zIndex ?? 1300;

  const el = document.createElement('div');
  if (opts.dataAttr) el.setAttribute(`data-${opts.dataAttr}`, '1');
  el.style.cssText = `
    position:fixed; top:${rect.bottom + 6}px;
    left:${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 12))}px;
    z-index:${zIndex}; width:${width}px; max-height:${maxHeight}; overflow:hidden;
    background:#181818; color:#eee; border:1px solid #333; border-radius:8px;
    box-shadow:0 16px 40px rgba(0,0,0,0.7); padding:8px;
    display:flex; flex-direction:column; gap:6px;
    ${opts.extraStyle ?? ''}
  `;
  el.appendChild(opts.content);
  // Stop mousedown bubbling so the document-scoped 'away' listener
  // doesn't fire when the user clicks INSIDE the popover (e.g. on a
  // search input or list item).
  el.addEventListener('mousedown', (e) => e.stopPropagation());
  document.body.appendChild(el);
  clampPopupToViewport(el, { flipAboveAnchor: rect });

  // ---- dismissal plumbing ----
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', awayHandler, true);
    document.removeEventListener('keydown', escHandler);
    el.remove();
    opts.onClose?.();
  };
  const awayHandler = (e: MouseEvent) => {
    if (el.contains(e.target as Node)) return;
    if (opts.anchor.contains(e.target as Node)) return;       // anchor click is the caller's responsibility
    close();
  };
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  // Defer attaching so the click that opened the popover doesn't
  // immediately dismiss it.
  setTimeout(() => {
    if (closed) return;
    document.addEventListener('mousedown', awayHandler, true);
    document.addEventListener('keydown', escHandler);
  }, 0);

  return { el, close };
}
