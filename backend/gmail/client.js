// Town Inbox — shared Gmail client factory.
//
// Three previous copies of `google.gmail({ version: 'v1', auth: c })`
// lived in routes/gmail.js, services/syncEngine.js, and
// services/mutationQueue.js. Consolidated here so a future Gmail API
// version bump or auth-wrapping change touches one line, not three.

import { google } from 'googleapis';

/**
 * @param {import('google-auth-library').OAuth2Client} oauth2Client
 * @returns {import('googleapis').gmail_v1.Gmail}
 */
export function getGmailClient(oauth2Client) {
  return google.gmail({ version: 'v1', auth: oauth2Client });
}
