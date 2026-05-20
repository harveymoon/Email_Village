// Town Inbox — sync engine (backfill + incremental).
//
// Backfill: first-boot population of the local SQLite store. Pages
// through users.threads.list with no query filter, batches threads.get
// with format='metadata', upserts thread + per-message rows.
//
// Incremental sync (Phase D, added below): users.history.list deltas
// applied to the local store every ~60s while the app runs.
//
// All work happens AFTER auth.js has loaded tokens from disk — call
// `bootstrapSync()` once from server.js on startup.

import { getAllAuthenticatedClients, reportInvalidGrant } from '../routes/auth.js';
import { accountsRepo, labelsRepo, threadsRepo, messagesRepo } from '../db/repositories.js';
import { parseThreadMeta } from '../gmail/parseMessage.js';
import { getGmailClient } from '../gmail/client.js';
import { gmailLimiter } from './rateLimiter.js';
import { startMutationDrain } from './mutationQueue.js';

const PAGE_SIZE = 100;          // Gmail's max for threads.list
const GET_BATCH = 10;           // how many threads.get calls to fire in parallel

const gmail = getGmailClient;

// In-flight tracker so two callers can't kick off duplicate backfills
// for the same account. Resolves to true when complete.
const backfillsInFlight = new Map();

/**
 * One-time bulk population of the local store for a single account.
 * Idempotent — re-runs the upsert path for every thread, so a partial
 * previous run resumes cleanly. After completion, stores historyId so
 * incremental sync can take over.
 */
export async function backfillAccount(email, client) {
  if (backfillsInFlight.has(email)) return backfillsInFlight.get(email);
  const promise = (async () => {
    const g = gmail(client);
    // If a previous run completed the count (done >= total) but
    // crashed before marking last_full_sync_at, treat that as done
    // and skip the full re-walk. Saves ~25min on a 69k-thread inbox.
    //
    // We also use the actual on-disk thread count as a lower bound on
    // "done" — `backfill_done` gets reset to 0 by markBackfillStart on
    // every relaunch even when the threads table already holds the
    // results of past runs. Without this floor, the second launch
    // after a successful first run would mis-detect us as having made
    // zero progress.
    const existing = accountsRepo.get(email);
    const existingThreadCount = threadsRepo.countForAccount(email);
    const effectiveDone = Math.max(existing?.backfill_done || 0, existingThreadCount);
    if (existing?.backfill_total && effectiveDone >= existing.backfill_total) {
      console.log(`[sync] ${email}: previous backfill reached ${effectiveDone}/${existing.backfill_total} (${existingThreadCount.toLocaleString()} on disk), finalising`);
      try {
        await gmailLimiter.take(1);
        const prof = await g.users.getProfile({ userId: 'me' });
        accountsRepo.markBackfillComplete(email, prof.data.historyId);
        console.log(`[sync] ${email}: marked complete, historyId=${prof.data.historyId}`);
        return true;
      } catch (err) {
        console.warn(`[sync] ${email}: finalisation failed, will full-resync next time:`, err.message);
        // Fall through to a full backfill below.
      }
    }
    // We already have `existingThreadCount` from the short-circuit
    // check above. After a partial backfill the threads table keeps
    // every row even though `backfill_done` gets reset to 0 by
    // markBackfillStart below. Re-fetching threads we have wastes
    // Gmail quota AND makes the progress meter read "0/69258" when
    // really we have most of them. Seed backfill_done with the
    // existing count and skip the threads.get call for any id we
    // already have on disk.
    console.log(`[sync] backfill start: ${email} (${existingThreadCount.toLocaleString()} threads already in local store)`);

    // Capture a baseline historyId BEFORE we list anything. Using the
    // post-backfill historyId could skip changes that happen during the
    // backfill itself; using the pre-backfill historyId means we'll
    // re-process some labelAdded events for threads we just upserted,
    // which is harmless (idempotent).
    let baselineHistoryId = null;
    try {
      await gmailLimiter.take(1);
      const prof = await g.users.getProfile({ userId: 'me' });
      baselineHistoryId = prof.data.historyId;
      accountsRepo.markBackfillStart(email, prof.data.threadsTotal);
      // Seed backfill_done with the threads already on disk so the
      // progress meter starts at the right place and the "previous
      // backfill reached done >= total" short-circuit on next launch
      // has accurate input.
      if (existingThreadCount > 0) accountsRepo.bumpBackfillDone(email, existingThreadCount);
    } catch (err) {
      console.warn(`[sync] ${email}: getProfile failed during backfill init:`, err.message);
    }

    // 1. Refresh the labels catalogue (cheap, once per backfill).
    try {
      await gmailLimiter.take(1);
      const r = await g.users.labels.list({ userId: 'me' });
      // Pull threadsTotal/threadsUnread per user-label for the badge layer
      // — but be cheap about it: just trust labels.list's first pass and
      // let incremental sync correct any drift later.
      labelsRepo.upsertMany(email, (r.data.labels || []).map(l => ({
        id: l.id, name: l.name, type: l.type,
        threadsTotal: l.threadsTotal ?? null, threadsUnread: l.threadsUnread ?? null,
      })));
    } catch (err) {
      console.warn(`[sync] ${email}: labels.list failed:`, err.message);
      if (err.message?.includes('invalid_grant')) {
        reportInvalidGrant(email);
        return false;
      }
    }

    // 2. Page through threads.list with no q filter — gets every thread
    //    in every label (including spam/trash, which we treat the same).
    let pageToken;
    let pagesDone = 0;
    let totalUpserted = 0;
    do {
      await gmailLimiter.take(5);
      let listResp;
      try {
        listResp = await g.users.threads.list({
          userId: 'me',
          maxResults: PAGE_SIZE,
          pageToken,
        });
      } catch (err) {
        if (err.message?.includes('invalid_grant')) {
          reportInvalidGrant(email);
          return false;
        }
        console.warn(`[sync] ${email}: threads.list failed (page ${pagesDone}):`, err.message);
        // Brief back-off + retry once; if it still fails, abort and let
        // the next bootstrap pick up where we left off.
        await new Promise(r => setTimeout(r, 5000));
        try {
          listResp = await g.users.threads.list({ userId: 'me', maxResults: PAGE_SIZE, pageToken });
        } catch (err2) {
          console.warn(`[sync] ${email}: threads.list retry also failed, bailing`, err2.message);
          return false;
        }
      }
      const allThreadIds = (listResp.data.threads || []).map(t => t.id);
      pageToken = listResp.data.nextPageToken;
      // Drop ids we already have — saves a metadata.get round-trip (~5
      // quota units) per skipped thread. After a partial backfill this
      // can be most of a page; on a true fresh start it's none of them.
      // History sync covers any subsequent updates so we don't need to
      // re-fetch metadata to catch later changes.
      const threadIds = allThreadIds.filter(id => !threadsRepo.existsById(`${email}:${id}`));
      const skipped = allThreadIds.length - threadIds.length;
      if (skipped > 0) {
        console.log(`[sync] ${email}: skipped ${skipped}/${allThreadIds.length} already in local store on page ${pagesDone + 1}`);
      }

      // 3. Batch threads.get with format='metadata'. On rate-limit
      //    failures (429 / "Quota exceeded"), pause progressively
      //    longer (5s → 30s → 60s → 120s) and retry the batch before
      //    giving up. Without this the per-minute quota dip just
      //    spams the log and drops threads on the floor.
      for (let i = 0; i < threadIds.length; i += GET_BATCH) {
        const batch = threadIds.slice(i, i + GET_BATCH);
        let results;
        let backoff = 0;
        for (let attempt = 0; attempt < 4; attempt++) {
          await gmailLimiter.take(batch.length * 5);
          results = await Promise.allSettled(batch.map(id =>
            g.users.threads.get({
              userId: 'me', id,
              format: 'metadata',
              metadataHeaders: ['From', 'To', 'Subject', 'Date', 'List-Unsubscribe', 'List-Unsubscribe-Post'],
            })
          ));
          // If anything in this batch hit the quota, sleep + retry the
          // full batch. allSettled returns each promise's own status,
          // so we detect quota by scanning rejected reasons.
          const quotaHit = results.some(r => r.status === 'rejected'
            && /quota|rate.?limit|429|userRateLimit/i.test(r.reason?.message || ''));
          if (!quotaHit) break;
          backoff = backoff === 0 ? 5000 : Math.min(backoff * 2, 120_000);
          console.warn(`[sync] ${email}: quota hit on batch (attempt ${attempt + 1}), sleeping ${backoff / 1000}s`);
          await new Promise(r => setTimeout(r, backoff));
        }
        for (const r of results) {
          if (r.status !== 'fulfilled') {
            console.warn(`[sync] ${email}: threads.get failed:`, r.reason?.message);
            continue;
          }
          const parsed = parseThreadMeta(email, r.value.data);
          threadsRepo.upsertWithLabels(parsed.thread, parsed.labelRawIds);
          messagesRepo.upsertManyMeta(parsed.messages);
          totalUpserted++;
        }
        accountsRepo.bumpBackfillDone(email, results.filter(r => r.status === 'fulfilled').length);
      }

      pagesDone++;
      if (pagesDone % 5 === 0 || !pageToken) {
        const acct = accountsRepo.get(email);
        console.log(`[sync] ${email}: ${totalUpserted} threads backfilled (${acct?.backfill_done}/${acct?.backfill_total ?? '?'})`);
      }
    } while (pageToken);

    // 4. Mark done. If we managed to capture a baseline historyId, use
    //    it; otherwise re-fetch now (any history events between the two
    //    fetches will be re-applied harmlessly by the incremental sync).
    let finalHistoryId = baselineHistoryId;
    if (!finalHistoryId) {
      try {
        await gmailLimiter.take(1);
        const prof = await g.users.getProfile({ userId: 'me' });
        finalHistoryId = prof.data.historyId;
      } catch { /* swallow — incremental sync will refetch on next tick */ }
    }
    accountsRepo.markBackfillComplete(email, finalHistoryId);
    console.log(`[sync] backfill complete: ${email} — ${totalUpserted} threads, historyId=${finalHistoryId}`);
    return true;
  })();
  backfillsInFlight.set(email, promise);
  promise.finally(() => backfillsInFlight.delete(email));
  return promise;
}

/**
 * Bootstrap entry point — called by server.js on startup. For each
 * authenticated account: register it in our DB, then kick off backfill
 * if not already done. Backfills run in parallel (one in-flight per
 * account, but multiple accounts can run together since each respects
 * the shared gmailLimiter). Also starts the history poller so any
 * already-backfilled account stays in sync going forward.
 */
export async function bootstrapSync() {
  const clients = getAllAuthenticatedClients();
  const emails = Object.keys(clients);
  if (!emails.length) {
    console.log('[sync] no authenticated accounts — skipping bootstrap');
    return;
  }
  for (const email of emails) {
    accountsRepo.ensure(email);
    const acct = accountsRepo.get(email);
    if (acct?.last_full_sync_at) {
      console.log(`[sync] ${email}: backfill already done at ${new Date(acct.last_full_sync_at).toISOString()}`);
      continue;
    }
    // Fire-and-forget; we don't block server startup on backfill.
    backfillAccount(email, clients[email]).catch(err =>
      console.error(`[sync] backfill rejected for ${email}:`, err));
  }
  // History poller covers every account (including ones still mid-
  // backfill — pollHistoryFor early-returns if history_id is unset).
  startHistoryPolling();
  // Mutation queue drain runs even with zero accounts (so we drain the
  // last few items if the user signs out mid-batch — once they sign
  // back in those will succeed).
  startMutationDrain();
}

/**
 * On-demand backfill trigger — exposed for the "Resync this account"
 * dev menu item we'll wire later, and for the auth.js callback path
 * (after a new account signs in, we want backfill to start right away
 * without waiting for the next server restart).
 */
export function kickoffBackfillFor(email) {
  const clients = getAllAuthenticatedClients();
  const client = clients[email];
  if (!client) {
    console.warn(`[sync] kickoff requested for unknown account ${email}`);
    return;
  }
  accountsRepo.ensure(email);
  backfillAccount(email, client).catch(err =>
    console.error(`[sync] manual backfill rejected for ${email}:`, err));
}

// =========================================================================
// Incremental sync — Phase D
// =========================================================================
//
// Once an account's backfill has completed and `accounts.history_id` is
// set, we can poll users.history.list with that startHistoryId on a
// timer. Each response is a list of deltas (messagesAdded,
// messagesDeleted, labelsAdded, labelsRemoved). We apply them to the
// DB in a single transaction per delta and advance accounts.history_id
// to the response's `historyId`.
//
// Gmail retains history records for ~7 days. If startHistoryId is older
// than that, history.list returns 404 — we recover by re-running the
// account's backfill (which is itself idempotent).

const HISTORY_POLL_MS = 60_000;          // 60s — compromise between freshness + quota
const HISTORY_PAGE_MAX = 5;              // cap pagination to keep tail-latency bounded; rest catches up next tick

let historyPollHandle = null;

/**
 * Apply a single batch of history records to the local DB. Records
 * come in the order Gmail returns them (oldest first), which is what
 * we want — applying out of order could undo a labelRemoved with a
 * labelAdded that was meant to fire FIRST.
 */
async function applyHistoryRecords(email, client, records) {
  const g = gmail(client);
  for (const record of records || []) {
    // messagesAdded — a brand-new message landed in a thread. We
    // upsert via threads.get(metadata) so the thread row + its
    // messages stay coherent. Cheap (5 units) per new thread; in
    // practice deltas are small.
    for (const ma of record.messagesAdded || []) {
      const m = ma.message;
      if (!m?.threadId) continue;
      try {
        await gmailLimiter.take(5);
        const r = await g.users.threads.get({
          userId: 'me', id: m.threadId,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date', 'List-Unsubscribe', 'List-Unsubscribe-Post'],
        });
        const parsed = parseThreadMeta(email, r.data);
        threadsRepo.upsertWithLabels(parsed.thread, parsed.labelRawIds);
        messagesRepo.upsertManyMeta(parsed.messages);
      } catch (err) {
        console.warn(`[sync] ${email}: history messagesAdded threads.get ${m.threadId} failed:`, err.message);
      }
    }
    for (const md of record.messagesDeleted || []) {
      const tid = md.message?.threadId;
      if (!tid) continue;
      // Gmail's "messageDeleted" is per-message, but the thread might
      // still have other messages. Safer: re-fetch the thread; if it
      // 404s we delete locally; otherwise upsert (which patches
      // message_count to the new value).
      const prefixed = `${email}:${tid}`;
      try {
        await gmailLimiter.take(5);
        const r = await g.users.threads.get({ userId: 'me', id: tid, format: 'metadata' });
        const parsed = parseThreadMeta(email, r.data);
        threadsRepo.upsertWithLabels(parsed.thread, parsed.labelRawIds);
        messagesRepo.upsertManyMeta(parsed.messages);
      } catch (err) {
        if (err.code === 404 || /Requested entity was not found/i.test(err.message || '')) {
          threadsRepo.remove(prefixed);
        } else {
          console.warn(`[sync] ${email}: history messagesDeleted ${tid} re-fetch failed:`, err.message);
        }
      }
    }
    // Label deltas are the most common case (move-to, mark-read).
    // No network call — just patch thread_labels + flip is_read.
    const labelDeltas = new Map(); // threadId → { add: Set, remove: Set }
    const collect = (entries, side) => {
      for (const e of entries || []) {
        const tid = e.message?.threadId;
        if (!tid) continue;
        const prefixed = `${email}:${tid}`;
        if (!labelDeltas.has(prefixed)) labelDeltas.set(prefixed, { add: new Set(), remove: new Set() });
        for (const lid of (e.labelIds || [])) labelDeltas.get(prefixed)[side].add(lid);
      }
    };
    collect(record.labelsAdded, 'add');
    collect(record.labelsRemoved, 'remove');
    for (const [threadId, { add, remove }] of labelDeltas) {
      // If the thread isn't in our DB yet (rare — e.g. a brand-new
      // thread whose messagesAdded record we skipped on error), defer:
      // the next poll will pick it up.
      if (!threadsRepo.getById(threadId)) continue;
      threadsRepo.applyLabelDelta(threadId, [...add], [...remove]);
      if (remove.has('UNREAD')) threadsRepo.setReadFlag(threadId, true);
      if (add.has('UNREAD')) threadsRepo.setReadFlag(threadId, false);
    }
  }
}

/**
 * One iteration of incremental sync for one account. Walks pages until
 * `nextPageToken` runs out OR we hit HISTORY_PAGE_MAX (cap to keep
 * any single tick bounded; whatever's left flushes on the next tick).
 */
async function pollHistoryFor(email, client) {
  const acct = accountsRepo.get(email);
  if (!acct?.history_id) return;       // backfill hasn't finished yet
  if (!acct.last_full_sync_at) return;

  const g = gmail(client);
  let startHistoryId = acct.history_id;
  let pages = 0;
  let totalRecords = 0;
  let pageToken;

  while (pages < HISTORY_PAGE_MAX) {
    await gmailLimiter.take(2);
    let resp;
    try {
      resp = await g.users.history.list({
        userId: 'me',
        startHistoryId,
        historyTypes: ['labelAdded', 'labelRemoved', 'messageAdded', 'messageDeleted'],
        maxResults: 500,
        pageToken,
      });
    } catch (err) {
      // 404 here means startHistoryId aged out of Gmail's window (~7d).
      // Safest recovery: re-run backfill, which resyncs everything
      // and resets historyId to the current one. CRITICAL: clear the
      // stale history_id BEFORE invoking backfill — without that, the
      // 60s history poll keeps using the same stale id and hits 404
      // again on every tick until backfill finishes writing a new one
      // (potentially minutes of wasted quota + log spam).
      if (err.code === 404 || /historyId/i.test(err.message || '')) {
        console.warn(`[sync] ${email}: history too old, falling back to backfill`);
        accountsRepo.setHistoryId(email, null);
        accountsRepo.markBackfillStart(email, null);
        await backfillAccount(email, client);
      } else if (err.message?.includes('invalid_grant')) {
        reportInvalidGrant(email);
      } else {
        console.warn(`[sync] ${email}: history.list failed:`, err.message);
      }
      return;
    }
    const records = resp.data.history || [];
    if (records.length) {
      await applyHistoryRecords(email, client, records);
      totalRecords += records.length;
    }
    const newHistoryId = resp.data.historyId;
    if (newHistoryId) {
      accountsRepo.setHistoryId(email, newHistoryId);
      startHistoryId = newHistoryId;
    }
    pageToken = resp.data.nextPageToken;
    pages++;
    if (!pageToken) break;
  }
  if (totalRecords > 0) {
    console.log(`[sync] ${email}: applied ${totalRecords} history record(s)`);
  }
}

/**
 * Schedule the history poll. Called once from bootstrapSync. Each tick
 * fans out across all currently-authenticated accounts in parallel
 * (gmailLimiter keeps them honest on quota).
 */
function startHistoryPolling() {
  if (historyPollHandle) return;
  const tick = async () => {
    const clients = getAllAuthenticatedClients();
    await Promise.allSettled(Object.entries(clients).map(([email, client]) =>
      pollHistoryFor(email, client)));
  };
  // First tick after a short delay so we don't pile onto the initial
  // backfill burst that just kicked off.
  setTimeout(() => {
    tick().catch(err => console.warn('[sync] first history tick failed:', err.message));
    historyPollHandle = setInterval(() => {
      tick().catch(err => console.warn('[sync] history tick failed:', err.message));
    }, HISTORY_POLL_MS);
  }, 15_000);
}

// Exposed for tests / debug menus: trigger a single immediate poll
// without waiting for the scheduled tick.
export async function pollHistoryNow() {
  const clients = getAllAuthenticatedClients();
  await Promise.allSettled(Object.entries(clients).map(([email, client]) =>
    pollHistoryFor(email, client)));
}
