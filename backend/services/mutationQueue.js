// Town Inbox — optimistic mutation queue.
//
// Every user action that changes Gmail state (move thread to a new
// label, mark thread read/unread) is applied to the local SQLite store
// FIRST, then a mutation_queue row is inserted. A drain worker picks
// pending rows up in FIFO order, calls the actual Gmail API, deletes
// the row on success, and bumps attempts (with backoff) on transient
// failure. 4xx (non-auth) failures revert the local change since the
// server rejected it permanently.
//
// This decouples the UI from network latency / Gmail downtime: every
// click feels instant, and the queue catches up in the background. If
// the app crashes mid-drain, the queue picks back up on next launch
// because mutation_queue lives in the same SQLite file as the rest of
// the data.

import { getAllAuthenticatedClients, reportInvalidGrant } from '../routes/auth.js';
import { threadsRepo, mutationQueueRepo, atomicMutations } from '../db/repositories.js';
import { getGmailClient } from '../gmail/client.js';
import { gmailLimiter } from './rateLimiter.js';

const DRAIN_TICK_MS = 1000;
const BATCH_SIZE = 5;                 // how many ops we attempt per tick (each consumes its own quota)
const MAX_ATTEMPTS_BEFORE_FAIL = 6;   // ~exponential backoff to 64s before we give up

const gmail = getGmailClient;

// ---------------- public: write-through helpers ----------------
//
// These are what the renderer (via IPC in Phase F, or directly via HTTP
// in the legacy routes) calls instead of hitting Gmail itself. They
// (1) apply the change to the local DB so the UI reads see the new
// state immediately, and (2) enqueue the matching Gmail call.

/**
 * Apply a label modification to the local thread + enqueue the Gmail
 * call IN A SINGLE TRANSACTION. If anything fails between the local
 * apply and the queue insert, both roll back together — the UI never
 * shows a state that doesn't have a matching pending sync to Gmail.
 *
 * `threadId` is the prefixed form ("<account>:<gmailThreadId>").
 * `addRawIds` and `removeRawIds` are Gmail raw label IDs (system or
 * Label_xxx) — the same shape Gmail's threads.modify accepts.
 */
export function applyAndEnqueueModify(threadId, addRawIds, removeRawIds) {
  atomicMutations.modify(threadId, addRawIds, removeRawIds);
}

/**
 * Mark a thread read/unread locally + enqueue the Gmail call as a
 * single transaction (see applyAndEnqueueModify for the rationale).
 */
export function applyAndEnqueueMarkRead(threadId, isRead) {
  atomicMutations.markRead(threadId, isRead);
}

// ---------------- drain worker ----------------

let drainHandle = null;

/**
 * Single tick: pick up to BATCH_SIZE pending rows and try to push each
 * to Gmail. Failures are categorised as transient (retry with backoff)
 * or permanent (mark failed + revert local change).
 */
async function drainOnce() {
  const pending = mutationQueueRepo.pickPending(BATCH_SIZE);
  if (!pending.length) return;
  const clients = getAllAuthenticatedClients();

  await Promise.all(pending.map(async (row) => {
    const account = (row.thread_id.split(':')[0] || '').toLowerCase();
    const client = clients[account];
    if (!client) {
      // No client → either logged out or invalid_grant. Leave the row
      // pending; once re-authed the next tick will pick it back up.
      console.warn(`[queue] no client for ${account}, leaving #${row.id} pending`);
      return;
    }
    mutationQueueRepo.markInflight(row.id);
    const g = gmail(client);
    const gmailThreadId = row.thread_id.slice(account.length + 1);
    try {
      await gmailLimiter.take(10);     // threads.modify is ~10 units
      if (row.op === 'modify') {
        await g.users.threads.modify({
          userId: 'me', id: gmailThreadId,
          requestBody: {
            addLabelIds: JSON.parse(row.add_labels_json || '[]'),
            removeLabelIds: JSON.parse(row.remove_labels_json || '[]'),
          },
        });
      } else if (row.op === 'markRead') {
        await g.users.threads.modify({
          userId: 'me', id: gmailThreadId,
          requestBody: {
            removeLabelIds: row.is_read ? ['UNREAD'] : [],
            addLabelIds: row.is_read ? [] : ['UNREAD'],
          },
        });
      } else {
        // Unknown op — treat as permanent failure so we don't loop forever.
        console.warn(`[queue] unknown op "${row.op}" on row #${row.id}, dropping`);
        mutationQueueRepo.remove(row.id);
        return;
      }
      mutationQueueRepo.remove(row.id);
    } catch (err) {
      const msg = err.message || String(err);
      const code = err.code || err.response?.status;
      if (msg.includes('invalid_grant')) {
        reportInvalidGrant(account);
        // Leave the row pending — once the account is re-authed it'll
        // get retried. No attempt-counter bump (this wasn't the row's
        // fault).
        mutationQueueRepo.bumpRetry(row.id, 'auth expired — waiting');
        return;
      }
      // 4xx (other than 401/403/429) = permanent failure: revert.
      const isPermanent = typeof code === 'number' && code >= 400 && code < 500 && code !== 401 && code !== 403 && code !== 429;
      if (isPermanent) {
        console.warn(`[queue] permanent fail on #${row.id} (${code}): ${msg}`);
        // Best-effort revert. We swap add ↔ remove since the original
        // modify never landed on Gmail, so the local DB has the wrong
        // state. For markRead we just flip back.
        if (row.op === 'modify') {
          threadsRepo.applyLabelDelta(
            row.thread_id,
            JSON.parse(row.remove_labels_json || '[]'),
            JSON.parse(row.add_labels_json || '[]'),
          );
        } else if (row.op === 'markRead') {
          threadsRepo.setReadFlag(row.thread_id, !row.is_read);
        }
        mutationQueueRepo.markFailed(row.id, msg);
        return;
      }
      // Quota errors (429 / Too many concurrent / userRateLimit) are
      // intrinsically transient — they say "your account hit a quota
      // window", not "this request is wrong". Never give up on them:
      // bump the retry counter, leave the row pending, and let the
      // limiter widen the gap before the next attempt. If we DID give
      // up on these, the local DB would say "moved" while Gmail still
      // says "in INBOX", and the next backfill (which re-fetches
      // threads.get from Gmail) would silently overwrite the local
      // move — exactly the bug the user reported as "I triaged 5000
      // emails down to 0 then rebooted and it's back to 18,109".
      const isQuota = /quota|rate.?limit|429|userRateLimit|too many concurrent/i.test(msg);
      const attempts = (row.attempts || 0) + 1;
      if (!isQuota && attempts >= MAX_ATTEMPTS_BEFORE_FAIL) {
        console.warn(`[queue] giving up on #${row.id} after ${attempts} attempts (non-quota): ${msg}`);
        mutationQueueRepo.markFailed(row.id, msg);
        return;
      }
      if (isQuota && attempts % 10 === 0) {
        // Don't spam — every 10th retry log a brief status so the user
        // knows the queue is alive and waiting on quota.
        const status = queueStatus();
        console.log(`[queue] #${row.id} still waiting on quota (attempt ${attempts}); ${status.pending} pending`);
      }
      // Effective backoff via the limiter: take an exponentially larger
      // gulp of tokens so the next tick of THIS row is naturally delayed.
      // Cap at 120s — past that the backfill is probably what's eating
      // quota, and a bigger sleep here just stalls forever.
      mutationQueueRepo.bumpRetry(row.id, msg);
      const backoffSec = Math.min(120, 2 ** Math.min(attempts, 7));
      await gmailLimiter.take(backoffSec * 5);
    }
  }));
}

export function startMutationDrain() {
  if (drainHandle) return;
  // Resurrect any rows stuck inflight (backend crashed mid-tick) or
  // marked failed by previous runs. Without this, every restart left
  // a growing pile of "permanently stuck" mutations that the local DB
  // believed had succeeded — the moves looked fine in the UI but
  // never propagated to Gmail. On the next backfill the threads.get
  // round-trips replaced those local labels with what Gmail still
  // said, silently undoing the user's work.
  try { mutationQueueRepo.resurrectStuckRows(); }
  catch (err) { console.warn('[queue] resurrect failed:', err.message); }
  drainHandle = setInterval(() => {
    drainOnce().catch(err => console.warn('[queue] drain tick failed:', err.message));
  }, DRAIN_TICK_MS);
}

export function stopMutationDrain() {
  if (drainHandle) { clearInterval(drainHandle); drainHandle = null; }
}

/**
 * Snapshot of queue health — exposed for the UI's "sync status" badge
 * (Phase F). Cheap (COUNT(*) on a small table).
 */
export function queueStatus() {
  return { pending: mutationQueueRepo.countPending() };
}
