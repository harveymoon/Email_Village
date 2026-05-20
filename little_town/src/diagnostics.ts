// Town Inbox — renderer crash + freeze diagnostics.
//
// Everything here forwards to console.* so the Electron main process
// (which mirrors console-message events into renderer.log) keeps a
// persistent paper trail of what was happening right before the
// window went black. None of this should change app behaviour — it's
// pure instrumentation.
//
// What gets captured:
//   - Uncaught exceptions (window.onerror) with full stack
//   - Unhandled promise rejections (unhandledrejection)
//   - Long tasks >150ms via PerformanceObserver — these are what
//     freeze the Phaser render loop and trigger the black screen
//   - A monotonic heartbeat tick every 5s so the log shows a steady
//     pulse; gaps in the pulse pinpoint when the main thread was
//     blocked
//   - Page lifecycle: visibility changes + before-unload, useful for
//     distinguishing "user closed it" from "process died"

let installed = false;

export function installCrashDiagnostics(): void {
  if (installed) return;
  installed = true;

  // (1) Uncaught exceptions. window.onerror gets the original Error
  // (not the wrapped string) when available, which preserves the
  // stack frame Phaser/Vite would otherwise mangle.
  window.addEventListener('error', (e: ErrorEvent) => {
    const where = e.filename ? ` at ${e.filename}:${e.lineno}:${e.colno}` : '';
    const stack = e.error?.stack ? `\n${e.error.stack}` : '';
    console.error(`[uncaught] ${e.message}${where}${stack}`);
  });

  // (2) Promise rejections that nothing .catch()'d. These are the
  // most common silent-failure source in async-heavy code (e.g. an
  // api.modify call that throws after the user navigated away).
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    const stack = reason?.stack ? `\n${reason.stack}` : '';
    const msg = reason?.message || String(reason);
    console.error(`[unhandled-rejection] ${msg}${stack}`);
  });

  // (3) Long tasks. The PerformanceObserver longtask entry fires for
  // any single task that ran >50ms on the main thread — those are
  // the things that freeze Phaser's render loop. We bump the
  // threshold to 150ms so we don't drown in normal frames; anything
  // >150ms is firmly in "user can see a hitch" territory and ≥500ms
  // is "screen visibly froze". Includes attribution: the script URL +
  // start time so we can correlate against console logs around the
  // same timestamp.
  try {
    const po = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const dur = Math.round(entry.duration);
        if (dur < 150) continue;
        const attrSrc = (entry as any).attribution?.[0]?.containerSrc
          || (entry as any).attribution?.[0]?.name
          || 'unknown';
        const severity = dur >= 500 ? 'FREEZE' : 'slow';
        console.warn(`[longtask:${severity}] ${dur}ms — src=${attrSrc}`);
      }
    });
    po.observe({ entryTypes: ['longtask'] });
  } catch { /* not supported — ignore */ }

  // (4) Heartbeat: every 5s, log a tick. If the tick stops appearing
  // in the log, the main thread was blocked. Cheap (one console line
  // every 5s = nothing) and self-documenting: the timestamps in the
  // log between two ticks tell you how long the freeze lasted.
  let tickN = 0;
  setInterval(() => {
    tickN++;
    if (tickN % 12 === 0) console.log(`[heartbeat] tick ${tickN} (${(tickN * 5)}s alive)`);
  }, 5000);

  // (5) Lifecycle. Distinguishes user-driven close from process death.
  document.addEventListener('visibilitychange', () => {
    console.log(`[lifecycle] visibility=${document.visibilityState}`);
  });
  window.addEventListener('beforeunload', () => {
    console.log('[lifecycle] beforeunload — page about to navigate / close');
  });
  window.addEventListener('pagehide', (e) => {
    console.log(`[lifecycle] pagehide persisted=${e.persisted}`);
  });

  console.log('[diagnostics] crash + freeze diagnostics installed');
}

/**
 * Time-and-log a heavy synchronous or async operation. Useful for
 * the suspect callsites identified by [longtask:FREEZE] entries —
 * wrap them once with this and the next freeze tells you the exact
 * one responsible.
 *
 *   await timed('bulk-move-cache-patch', () => threadCache.bulkPatchAndMove(...));
 */
export function timed<T>(label: string, fn: () => T): T {
  const t0 = performance.now();
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.then(
        (v) => { logIfSlow(label, t0); return v; },
        (err) => { logIfSlow(label, t0, err); throw err; },
      ) as unknown as T;
    }
    logIfSlow(label, t0);
    return result;
  } catch (err) {
    logIfSlow(label, t0, err);
    throw err;
  }
}

function logIfSlow(label: string, t0: number, err?: unknown): void {
  const dur = Math.round(performance.now() - t0);
  if (err) console.warn(`[timed] ${label} THREW after ${dur}ms:`, err);
  else if (dur >= 100) console.log(`[timed] ${label} ${dur}ms`);
}
