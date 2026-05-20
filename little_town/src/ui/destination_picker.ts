// Town Inbox — reusable destination picker.
//
// Renders a search input + filtered list of move destinations inside a
// Popover. Used by EVERY "Move to…" flow (NPC popup, email content
// popup, person profile move-all, floor-accordion quick-move, etc.).
//
// Before this module: each callsite had ~80 lines of nearly-identical
// search/render/click code with subtly different hover styles, chip
// formats, and dismissal bugs.
//
// On pick: the popover closes automatically. The caller's onPick gets
// the destination row plus the user's effective "override label" —
// either a floor matched via search, or a rule suggestion's
// specific sub-label (`Hobbies/Patreon` even when the building is
// bound to `Hobbies`).

import { openPopover, type PopoverHandle } from './popover';
import { destinationMatches, matchedFloor, applySuggestionStyle } from '../email_ui';

export interface Destination {
  labelId: string;
  label: string;
  buildingName: string;
  floors?: string[];
  suggestion?: { confidence: number; reason: string; label?: string };
}

export interface DestinationPickerOpts {
  anchor: HTMLElement;
  destinations: Destination[];
  /** Called when the user picks a row. Picker closes automatically just before. */
  onPick: (dest: Destination, overrideLabel: string | undefined) => void | Promise<void>;
  /** Optional header line above the search box ("Move 12 threads to…"). */
  header?: string;
  /** Optional placeholder for the search input. */
  searchPlaceholder?: string;
  /** Width passed through to openPopover. */
  width?: number;
  /** data-attr for de-duping (so opening picker A while picker B is up kills B). */
  dataAttr?: string;
  /** Max destinations to render at once (default 200). */
  maxRender?: number;
  /** Called when popover closes WITHOUT a pick (Esc, click-outside). */
  onCancel?: () => void;
}

export function openDestinationPicker(opts: DestinationPickerOpts): PopoverHandle {
  const content = document.createElement('div');
  content.style.cssText = 'display:flex; flex-direction:column; gap:6px;';

  // Optional header line
  if (opts.header) {
    const h = document.createElement('div');
    h.textContent = opts.header;
    h.style.cssText = 'color:#d8b8ff; font:600 12px ui-sans-serif,system-ui,sans-serif; padding:4px 6px;';
    content.appendChild(h);
  }

  const search = document.createElement('input');
  search.placeholder = opts.searchPlaceholder ?? 'Search buildings / labels…';
  search.spellcheck = false;
  search.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px; padding:6px 10px; font:13px ui-sans-serif,system-ui,sans-serif;';

  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:2px; overflow-y:auto;';

  content.appendChild(search);
  content.appendChild(list);

  let picked = false;
  const handle = openPopover({
    anchor: opts.anchor,
    content,
    width: opts.width ?? 360,
    dataAttr: opts.dataAttr,
    onClose: () => { if (!picked) opts.onCancel?.(); },
  });

  const maxRender = opts.maxRender ?? 200;
  const render = () => {
    list.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    const filtered = opts.destinations.filter(d => destinationMatches(d, q));
    for (const d of filtered.slice(0, maxRender)) {
      list.appendChild(renderRow(d, q));
    }
    if (!filtered.length) {
      const none = document.createElement('div');
      none.textContent = opts.destinations.length
        ? `No matches for "${search.value}".`
        : 'No destinations available.';
      none.style.cssText = 'color:#888; font-style:italic; padding:18px; text-align:center;';
      list.appendChild(none);
    }
  };

  const renderRow = (d: Destination, q: string): HTMLDivElement => {
    const row = document.createElement('div');
    row.style.cssText = 'padding:8px 10px; cursor:pointer; border-radius:4px;';
    const viaFloor = q ? matchedFloor(d, q) : null;
    const sugg = applySuggestionStyle(row, d);
    // When a rule suggestion targets a sub-label (e.g. Hobbies/Patreon
    // on a building bound to Hobbies), surface the path in the sub-line.
    const suggFloor = (!viaFloor && sugg && sugg.label && sugg.label !== d.label) ? sugg.label : null;
    const subText = viaFloor ? `via ${viaFloor}` : (suggFloor || d.label);
    const subColor = viaFloor || suggFloor ? '#a8e6c0' : '#7a8b9f';
    const suggLine = sugg
      ? `<div style="color:#6ad26a; font:600 10px ui-monospace,Consolas,monospace;">✨ Suggested · ${escapeHtml(sugg.reason)}</div>`
      : '';
    row.innerHTML = `<div style="font:600 13px ui-sans-serif,system-ui,sans-serif; color:#fff;">${escapeHtml(d.buildingName)}</div>
                     <div style="color:${subColor}; font:11px ui-monospace,Consolas,monospace;">${escapeHtml(subText)}</div>${suggLine}`;
    row.addEventListener('mouseenter', () => row.style.background = sugg ? 'rgba(106, 210, 106, 0.15)' : '#22272e');
    row.addEventListener('mouseleave', () => row.style.background = sugg ? 'rgba(106, 210, 106, 0.07)' : 'transparent');
    row.addEventListener('click', async () => {
      // Override label priority: explicit floor-search match wins
      // over the rule-suggestion's matched label. Either way flows
      // through to the caller's onPick.
      const overrideLabel = viaFloor || sugg?.label || undefined;
      picked = true;
      handle.close();
      try { await opts.onPick(d, overrideLabel); }
      catch (err) { console.warn('[destination-picker] onPick failed:', err); }
    });
    return row;
  };

  search.addEventListener('input', render);
  render();
  setTimeout(() => search.focus(), 0);

  return handle;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
