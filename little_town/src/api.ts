// Thin wrapper around the Town Inbox backend (Express + googleapis).
// Default port is 3091; override by creating little_town/.env with:
//   VITE_API_BASE=http://localhost:<port>
// Every request goes with credentials: 'include' so the OAuth session
// cookie travels back. Backend CORS allows any localhost origin.

export const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || 'http://localhost:3091';

export interface AccountSummary { email: string; name?: string; picture?: string }

export interface AuthStatus {
  authenticated: boolean;
  accounts: AccountSummary[];
}

export interface GmailLabel {
  id: string;         // prefixed: "<account>:<labelId>"
  rawId: string;      // unprefixed Gmail label id
  account: string;    // owning account email
  name: string;
  type?: string;
  color?: string | null;
}

export interface EmailParticipant { name: string; email: string; avatar: string | null; }

export interface EmailMessage {
  id: string;             // prefixed: "<account>:<messageId>"
  threadId: string;       // prefixed: "<account>:<threadId>"
  account: string;        // owning account email
  from: EmailParticipant;
  to: string;
  subject: string;
  snippet: string;
  body: string;
  bodyHtml: string;
  date: string;
  labels: string[];
  isRead: boolean;
  isStarred: boolean;
  hasAttachment: boolean;
  // Populated by backend from List-Unsubscribe / List-Unsubscribe-Post
  // headers (or a body-scan fallback). Triggers the Unsubscribe button
  // in the email popup. The actual action is performed server-side via
  // POST /threads/:tid/messages/:mid/unsubscribe; the client only
  // checks for presence to decide whether to show the button.
  unsubscribe?: {
    http?: string;
    mailto?: string;
    oneClick: boolean;
    source: 'header' | 'body';
  } | null;
}

export interface UnsubscribeResult {
  method: 'oneclick' | 'mailto' | 'open' | 'none';
  ok: boolean;
  url?: string;
  status?: number;
  sentId?: string;
  error?: string;
}

export interface EmailThread {
  id: string;             // prefixed
  threadId: string;       // prefixed
  account: string;        // owning account email
  messageCount: number;
  from: EmailParticipant;
  to: string;
  subject: string;
  snippet: string;
  date: string;
  labels: string[];
  isRead: boolean;
  isStarred: boolean;
  hasAttachment: boolean;
  messages: EmailMessage[];
  originalFrom: EmailParticipant;
}

// Subscribe to auth-expired events. The scene's bootstrapAuth registers
// here so any API 401 across the app re-opens the sign-in modal without
// requiring callers to handle auth flow themselves.
type AuthExpiredHandler = () => void;
let onAuthExpired: AuthExpiredHandler | null = null;
export function setAuthExpiredHandler(fn: AuthExpiredHandler): void { onAuthExpired = fn; }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Retry once on TypeError ("Failed to fetch") — usually means the
  // backend hot-restarted (--watch) mid-request and dropped the
  // connection. A 400-500ms wait is enough to let Node re-bind.
  let resp: Response;
  try {
    resp = await fetch(`${API_BASE}${path}`, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
      ...init,
    });
  } catch (err) {
    if (err instanceof TypeError) {
      console.warn(`[api] transient fetch error on ${path}; retrying in 500ms…`);
      await new Promise(r => setTimeout(r, 500));
      try {
        resp = await fetch(`${API_BASE}${path}`, {
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
          ...init,
        });
      } catch (err2) {
        throw new Error(`Backend at ${API_BASE} unreachable. Check that the TownInbox-Backend window is still running.`);
      }
    } else {
      throw err;
    }
  }
  if (!resp.ok) {
    let body: any = null;
    try { body = await resp.json(); } catch { /* not JSON */ }
    if (resp.status === 401) {
      if (onAuthExpired) try { onAuthExpired(); } catch { /* ignore */ }
      throw new Error(`auth_expired: ${body?.message || 'not authenticated'}`);
    }
    const detail = body ? JSON.stringify(body) : await resp.text();
    throw new Error(`HTTP ${resp.status} ${path}: ${detail}`);
  }
  return resp.json() as Promise<T>;
}

export const api = {
  authStatus:  () => request<AuthStatus>('/auth/status'),
  profile:     () => request<{ accounts: Array<{ account: string; email: string; messagesTotal?: number; threadsTotal?: number; error?: string }> }>('/api/profile'),
  labels:      () => request<GmailLabel[]>('/api/labels'),
  threads:     (q: string, maxResults = 100) => request<{ emails: EmailThread[]; nextPageToken: string | null; resultSizeEstimate: number }>(`/api/emails?q=${encodeURIComponent(q)}&maxResults=${maxResults}`),
  // Pass either a labelName (resolved per-account on backend) or labelIds
  // (comma-separated; prefixed `<account>:<labelId>` or system label 'INBOX').
  unreadCount: (opts: { labelName?: string; labelIds?: string }) => {
    const q = opts.labelName
      ? `labelName=${encodeURIComponent(opts.labelName)}`
      : `labelIds=${encodeURIComponent(opts.labelIds || '')}`;
    return request<{ count: number; breakdown: Record<string, number> }>(`/api/unread-count?${q}`);
  },
  thread:      (prefixedId: string) => request<EmailThread>(`/api/threads/${encodeURIComponent(prefixedId)}`),
  modify:      (prefixedId: string, addLabels: string[], removeLabels: string[]) =>
                 request<{ success: boolean; account: string }>(`/api/emails/${encodeURIComponent(prefixedId)}/labels`, {
                   method: 'PATCH',
                   body: JSON.stringify({ addLabels, removeLabels }),
                 }),
  markRead:    (prefixedId: string, isRead: boolean) =>
                 request<{ success: boolean; account: string }>(`/api/emails/${encodeURIComponent(prefixedId)}/read`, {
                   method: 'PATCH',
                   body: JSON.stringify({ isRead }),
                 }),
  reply:       (prefixedThreadId: string, body: string, to?: string) =>
                 request<{ success: boolean; account: string; id: string; threadId: string }>(`/api/threads/${encodeURIComponent(prefixedThreadId)}/reply`, {
                   method: 'POST',
                   body: JSON.stringify({ body, to }),
                 }),
  unsubscribe: (prefixedThreadId: string, prefixedMsgId: string) =>
                 request<UnsubscribeResult>(`/api/threads/${encodeURIComponent(prefixedThreadId)}/messages/${encodeURIComponent(prefixedMsgId)}/unsubscribe`, {
                   method: 'POST',
                 }),
  disconnect:  (email: string) => request<{ success: boolean; remaining: string[] }>(`/auth/disconnect/${encodeURIComponent(email)}`, { method: 'POST' }),
  signInUrl:   (addAccount = false) =>
                 `${API_BASE}/auth/google?return_to=${encodeURIComponent(window.location.origin + window.location.pathname)}${addAccount ? '&add=true' : ''}`,
  reauthUrl:   (email: string) =>
                 `${API_BASE}/auth/google?return_to=${encodeURIComponent(window.location.origin + window.location.pathname)}&reauth=${encodeURIComponent(email)}`,
  // ---- Gmail filters / rules ----
  filters:     () => request<Array<{ id: string; rawId?: string; account: string; criteria?: any; action?: any; error?: string; message?: string }>>('/api/filters'),
  createFilter: (account: string, criteria: any, action: any) =>
                  request<{ success: boolean; id: string; rawId: string; account: string }>(`/api/filters?account=${encodeURIComponent(account)}`, {
                    method: 'POST',
                    body: JSON.stringify({ criteria, action }),
                  }),
  deleteFilter: (prefixedId: string) =>
                  request<{ success: boolean; account: string }>(`/api/filters/${encodeURIComponent(prefixedId)}`, { method: 'DELETE' }),

  // ---- Gameplay state persisted in SQLite (was localStorage) ----
  // The renderer used to keep building bindings, avatars, and people
  // overrides in localStorage. These get wiped on every origin change
  // (Vite dev vs packaged Electron, two machines, browser cleanup,
  // etc.), so the canonical store moved into the same SQLite file
  // that holds the threads they refer to.

  buildings: {
    list: () => request<Record<string, { customName: string | null; labels: string[] }>>('/api/buildings'),
    put:  (id: number | string, body: { customName?: string | null; labels?: string[] }) =>
            request<{ success: boolean; building: { buildingId: number; customName: string | null; labels: string[] } }>(
              `/api/buildings/${encodeURIComponent(String(id))}`,
              { method: 'PUT', body: JSON.stringify(body) },
            ),
  },
  avatars: {
    list:   () => request<Record<string, { body: string | null; eyes: string | null; outfit: string | null; hairstyle: string | null; accessory: string | null }>>('/api/avatars'),
    put:    (email: string, cfg: { body?: string | null; eyes?: string | null; outfit?: string | null; hairstyle?: string | null; accessory?: string | null }) =>
              request<{ success: boolean }>(`/api/avatars/${encodeURIComponent(email)}`, { method: 'PUT', body: JSON.stringify(cfg) }),
    remove: (email: string) =>
              request<{ success: boolean }>(`/api/avatars/${encodeURIComponent(email)}`, { method: 'DELETE' }),
  },
  peopleOverrides: {
    list: () => request<Record<string, any>>('/api/people-overrides'),
    put:  (email: string, ov: any) =>
            request<{ success: boolean }>(`/api/people-overrides/${encodeURIComponent(email)}`, {
              method: 'PUT', body: JSON.stringify(ov),
            }),
  },
  /** Ranked top inbox senders by unread count for the Inbox Triage view. */
  inboxSenders: (limit = 100) =>
    request<{
      senders: Array<{
        email: string;
        name: string | null;
        account: string;
        unread: number;
        latest_date: number;
        latest_subject: string | null;
      }>;
      totalUnread: number;
    }>(`/api/inbox-senders?limit=${limit}`),
  /** Bulk-move every unread INBOX thread for (email, account). Operates on the full SQLite store. */
  inboxBulkMove: (email: string, account: string, addLabels: string[], removeLabels: string[] = ['INBOX']) =>
    request<{ success: boolean; moved: number; threadIds: string[]; addRawIds: string[]; removeRawIds: string[] }>(
      '/api/inbox-senders/bulk-move',
      { method: 'POST', body: JSON.stringify({ email, account, addLabels, removeLabels }) },
    ),
  /** Bulk mark-read for every unread INBOX thread from (email, account). */
  inboxBulkMarkRead: (email: string, account: string) =>
    request<{ success: boolean; marked: number; threadIds: string[] }>(
      '/api/inbox-senders/bulk-mark-read',
      { method: 'POST', body: JSON.stringify({ email, account }) },
    ),
};
