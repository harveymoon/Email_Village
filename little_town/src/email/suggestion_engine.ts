// Town Inbox — Move-to suggestion engine.
//
// Pure functions that, given a thread + the user's rules + label
// cache + history of past co-filings, produce a ranked list of
// suggested destination labels for that thread. Consumed by:
//
//   - `destinationsForMove` in main.ts (the per-row Move-to picker
//     decoration) — turns the labelName list into a building list
//     and visually highlights matching rows.
//   - `findStaleRuleMatches` in main.ts (the Rules pane's "Suggested
//     moves" tab) — scans every cached inbox thread for senders whose
//     existing rules WOULD have filed them but never did.
//
// Extracted from main.ts during Phase I.1 of the codebase split. Pure
// functions taking explicit dependencies as args, no class state.

import type { EmailThread, GmailLabel } from '../api';

export interface Rule {
  id?: string;
  rawId?: string;
  account: string;
  criteria?: { from?: string; to?: string; subject?: string; query?: string };
  action?: { addLabelIds?: string[]; removeLabelIds?: string[] };
  error?: string;
  message?: string;
}

export interface RuleMatch {
  labelName: string;
  account: string;
}

export interface Suggestion {
  labelName: string;
  confidence: number;
  reason: string;
}

const SYSTEM_LABELS = new Set([
  'INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT',
]);

/**
 * Walk cached rules and return any whose `from` criterion matches the
 * given sender. Each match is mapped to the label name it would apply
 * (first non-system add label). Returns label names only — caller
 * wraps them as suggestions with the right confidence.
 */
export function rulesMatchingSender(
  senderEmail: string,
  rules: Rule[] | null,
  labels: GmailLabel[],
): RuleMatch[] {
  if (!rules) return [];
  const senderLower = senderEmail.toLowerCase();
  const out: RuleMatch[] = [];
  for (const r of rules) {
    if (r.error) continue;
    const from = (r.criteria?.from || '').toLowerCase().trim();
    if (!from) continue;
    const tokens = from.split(/[\s,]+|\bor\b/i).map(s => s.trim()).filter(Boolean);
    const senderMatches = tokens.some(tok => {
      if (tok === senderLower) return true;
      if (tok.startsWith('@')) return senderLower.endsWith(tok);
      if (!tok.includes('@') && tok.includes('.')) {
        return senderLower.endsWith('@' + tok) || senderLower.endsWith('.' + tok);
      }
      return false;
    });
    if (!senderMatches) continue;
    const adds = r.action?.addLabelIds || [];
    for (const rawId of adds) {
      if (SYSTEM_LABELS.has(rawId)) continue;
      const found = labels.find(l => l.account === r.account && l.rawId === rawId);
      if (found) out.push({ labelName: found.name, account: r.account });
    }
  }
  return out;
}

export interface ComputeMoveSuggestionsDeps {
  /** All rules across all accounts. Null = not yet loaded; engine skips rule signal. */
  rules: Rule[] | null;
  /** Every known label (any account). Used for name resolution. */
  labels: GmailLabel[];
  /** Every cached thread (any label) — used for sender-history + domain signals. */
  allThreads: EmailThread[];
  /** Optional callback fired when rules are null (kicks off a background load). */
  loadRulesCache?: () => void;
}

/**
 * Produce a ranked list of suggested destination labels for one thread.
 *
 * Signals in order of strength:
 *   1.00  Existing Gmail filter matches sender → that rule's add-label
 *   0.92  Thread has a List-Unsubscribe header → any Newsletters/* or JUNK label
 *   0.70-0.95  Same sender has N>=2 prior threads at this label
 *   0.55-0.85  Same @domain has N>=2 prior threads at this label
 *   0.60  Label name contains the sender's domain stem
 */
export function computeMoveSuggestions(
  thread: EmailThread,
  deps: ComputeMoveSuggestionsDeps,
): Suggestion[] {
  const senderEmail = thread.from?.email?.toLowerCase();
  if (!senderEmail) return [];
  const senderDomain = senderEmail.split('@')[1] || '';
  const labelByIdKey = new Map<string, string>();
  for (const l of deps.labels) labelByIdKey.set(`${l.account}:${l.rawId}`, l.name);

  // (1) + (2): per-label co-filings for same sender / same domain.
  const senderLabelCounts = new Map<string, number>();
  const domainLabelCounts = new Map<string, number>();
  for (const t of deps.allThreads) {
    if (t.threadId === thread.threadId) continue;
    const fromE = t.from?.email?.toLowerCase();
    if (!fromE) continue;
    const labelNames = t.labels
      .map(rawId => labelByIdKey.get(`${t.account}:${rawId}`))
      .filter((n): n is string => !!n && n !== 'INBOX');
    if (fromE === senderEmail) {
      for (const n of labelNames) senderLabelCounts.set(n, (senderLabelCounts.get(n) || 0) + 1);
    } else if (senderDomain && fromE.endsWith(`@${senderDomain}`)) {
      for (const n of labelNames) domainLabelCounts.set(n, (domainLabelCounts.get(n) || 0) + 1);
    }
  }

  const out: Suggestion[] = [];

  // (0) Rule match — top priority, confidence 1.0.
  if (deps.rules) {
    const seenLabels = new Set<string>();
    for (const m of rulesMatchingSender(senderEmail, deps.rules, deps.labels)) {
      if (seenLabels.has(m.labelName)) continue;
      seenLabels.add(m.labelName);
      out.push({
        labelName: m.labelName,
        confidence: 1.0,
        // Spell out the destination label in the reason. When the
        // rule targets a floor (e.g. Hobbies/Patreon) the popup row
        // shows only the building label ("Hobbies") in its sub-line,
        // so without this text the user has no signal that clicking
        // will file to the specific floor.
        reason: `Rule on ${m.account} → ${m.labelName}`,
      });
    }
  } else {
    deps.loadRulesCache?.();
  }

  // Unsubscribe signal — likely newsletter/junk.
  const hasUnsubscribe = Array.isArray(thread.messages) && thread.messages.some(m => !!m?.unsubscribe);
  if (hasUnsubscribe) {
    const seenLabels = new Set(out.map(s => s.labelName));
    for (const l of deps.labels) {
      if (seenLabels.has(l.name)) continue;
      const lower = l.name.toLowerCase();
      const isNewsletter = lower === 'newsletters' || lower.startsWith('newsletters/');
      const isJunk = lower === 'junk mail' || lower === 'junk' || lower.startsWith('junk/');
      if (!isNewsletter && !isJunk) continue;
      out.push({
        labelName: l.name,
        confidence: 0.92,
        reason: isJunk
          ? 'Has unsubscribe link — likely junk'
          : 'Has unsubscribe link — likely a newsletter',
      });
      seenLabels.add(l.name);
    }
  }

  // Sender history dominates among non-rule signals.
  for (const [labelName, count] of senderLabelCounts) {
    if (count < 2) continue;
    if (out.find(s => s.labelName === labelName)) continue;
    out.push({
      labelName,
      confidence: Math.min(0.95, 0.7 + count * 0.04),
      reason: `${count} email${count === 1 ? '' : 's'} from this sender already here`,
    });
  }

  // Domain history fills gaps the sender history didn't cover.
  for (const [labelName, count] of domainLabelCounts) {
    if (count < 2) continue;
    if (senderLabelCounts.has(labelName)) continue;
    if (out.find(s => s.labelName === labelName)) continue;
    out.push({
      labelName,
      confidence: Math.min(0.85, 0.55 + count * 0.03),
      reason: `${count} email${count === 1 ? '' : 's'} from @${senderDomain} already here`,
    });
  }

  // Label-name vs sender-domain stem match.
  if (senderDomain) {
    const stem = senderDomain.split('.')[0].toLowerCase();
    if (stem.length >= 4) {
      const seenLabels = new Set(out.map(s => s.labelName));
      for (const l of deps.labels) {
        if (seenLabels.has(l.name)) continue;
        const segments = l.name.toLowerCase().split('/');
        if (segments.some(seg => seg === stem || seg.includes(stem))) {
          out.push({ labelName: l.name, confidence: 0.6, reason: `Label name matches "${senderDomain}"` });
          seenLabels.add(l.name);
        }
      }
    }
  }

  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}

export interface StaleMatch<TThread = EmailThread, TRule = Rule> {
  thread: TThread;
  rule: TRule;
  targetLabel: string;
  buildingName: string | null;
}

/**
 * Scan a set of threads (intended: cached inbox threads) for senders
 * whose existing rules WOULD have filed them but never did. Used by
 * the "Suggested moves" tab in the Rules pane.
 */
export function findStaleRuleMatches(
  threads: EmailThread[],
  rules: Rule[],
  labels: GmailLabel[],
  resolveBuildingName: (labelName: string) => string | null,
): StaleMatch[] {
  const out: StaleMatch[] = [];
  for (const t of threads) {
    const senderLower = (t.from?.email || '').toLowerCase();
    if (!senderLower) continue;
    for (const r of rules) {
      if (r.error) continue;
      if (r.account !== t.account) continue;
      const from = (r.criteria?.from || '').toLowerCase().trim();
      if (!from) continue;
      const tokens = from.split(/[\s,]+|\bor\b/i).map(s => s.trim()).filter(Boolean);
      const senderMatches = tokens.some(tok => {
        if (tok === senderLower) return true;
        if (tok.startsWith('@')) return senderLower.endsWith(tok);
        if (!tok.includes('@') && tok.includes('.')) {
          return senderLower.endsWith('@' + tok) || senderLower.endsWith('.' + tok);
        }
        return false;
      });
      if (!senderMatches) continue;
      const adds = r.action?.addLabelIds || [];
      const targetRawId = adds.find(id => !SYSTEM_LABELS.has(id));
      if (!targetRawId) continue;
      if (t.labels.includes(targetRawId)) continue;
      const targetLabel = labels.find(l => l.account === r.account && l.rawId === targetRawId)?.name;
      if (!targetLabel) continue;
      out.push({
        thread: t, rule: r,
        targetLabel,
        buildingName: resolveBuildingName(targetLabel),
      });
    }
  }
  out.sort((a, b) => new Date(b.thread.date).getTime() - new Date(a.thread.date).getTime());
  return out;
}
