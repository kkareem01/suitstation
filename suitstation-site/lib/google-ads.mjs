/**
 * Minimal Google Ads API client — REST + fetch, no SDK.
 *
 * The official client library is a large dependency tree and this codebase
 * needs exactly one call: "how much did we spend, by month". So we do the
 * OAuth refresh-token exchange and one searchStream query by hand.
 *
 * Credentials come from env (set them in Vercel):
 *   GOOGLE_ADS_CLIENT_ID       OAuth client id
 *   GOOGLE_ADS_CLIENT_SECRET   OAuth client secret
 *   GOOGLE_ADS_REFRESH_TOKEN   long-lived refresh token from the OAuth flow
 *   GOOGLE_ADS_DEVELOPER_TOKEN Google Ads API developer token
 *   GOOGLE_ADS_CUSTOMER_ID     the account to report on, digits only
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID  optional — only when access is via a manager
 *
 * The same values live locally in tools/ads/google-ads.yaml (gitignored),
 * which is where the Python audit tooling reads them from.
 *
 * Nothing here logs a credential: errors report status codes and Google's
 * message, never the token or the request body.
 */

import * as log from './log.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_API_VERSION = 'v24';
const TIMEOUT_MS = 20000;

/** Access tokens last ~1h; refresh a minute early to avoid edge expiry. */
const TOKEN_SKEW_MS = 60 * 1000;
let cachedToken = null;   // { value, expiresAtMs }

function apiVersion() {
  const v = process.env.GOOGLE_ADS_API_VERSION;
  return /^v\d+$/.test(v || '') ? v : DEFAULT_API_VERSION;
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

export function readConfig() {
  return {
    clientId: process.env.GOOGLE_ADS_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET || '',
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN || '',
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '',
    customerId: digitsOnly(process.env.GOOGLE_ADS_CUSTOMER_ID),
    loginCustomerId: digitsOnly(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
  };
}

/** False when any required credential is missing — callers should skip, not fail. */
export function isConfigured() {
  const c = readConfig();
  return Boolean(c.clientId && c.clientSecret && c.refreshToken
    && c.developerToken && c.customerId);
}

function fetchWithTimeout(url, opts) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/** Test seam: drop the cached access token. */
export function resetTokenCache() {
  cachedToken = null;
}

async function getAccessToken(nowMs = Date.now()) {
  if (cachedToken && cachedToken.expiresAtMs > nowMs) {
    return { ok: true, token: cachedToken.value };
  }
  const c = readConfig();
  let res;
  try {
    res = await fetchWithTimeout(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: c.clientId,
        client_secret: c.clientSecret,
        refresh_token: c.refreshToken,
        grant_type: 'refresh_token',
      }),
    });
  } catch (e) {
    log.error('google-ads token request failed:', e?.message || e);
    return { ok: false, error: 'TOKEN_REQUEST_FAILED' };
  }

  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    // json.error is a short code like "invalid_grant" — safe to log, and the
    // single most useful thing to see when a refresh token gets revoked.
    log.error(`google-ads token exchange ${res.status}: ${json.error || 'no access_token'}`);
    return { ok: false, error: res.status === 400 ? 'REFRESH_TOKEN_REJECTED' : 'TOKEN_EXCHANGE_FAILED' };
  }

  const ttlMs = (Number(json.expires_in) || 3600) * 1000;
  cachedToken = { value: json.access_token, expiresAtMs: nowMs + ttlMs - TOKEN_SKEW_MS };
  return { ok: true, token: json.access_token };
}

/* ------------------------------------------------------------------ */
/* Reporting                                                           */
/* ------------------------------------------------------------------ */

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

/** First day of the month `back` months before `now`, as a UTC Date. */
function monthStart(now, back = 0) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
}

/** micros (millionths of the account currency) → cents. */
export function microsToCents(micros) {
  return Math.round(Number(micros || 0) / 10000);
}

/**
 * Account-level spend per calendar month, newest first.
 *
 * Queries the `customer` resource so the total covers every campaign — paused
 * ones included — which is what a cost-per-acquisition number needs.
 * segments.date is in the AD ACCOUNT's timezone, so the current month's figure
 * is "month to date" as Google reckons it.
 *
 * @returns {Promise<{ok: true, months: Array<{month: string, amountCents: number}>}
 *                  | {ok: false, error: string}>}
 */
export async function fetchMonthlySpend({ months = 12, now = new Date() } = {}) {
  if (!isConfigured()) return { ok: false, error: 'NOT_CONFIGURED' };

  const span = Math.max(1, Math.min(36, Number(months) || 12));
  const auth = await getAccessToken();
  if (!auth.ok) return { ok: false, error: auth.error };

  const c = readConfig();
  const start = ymd(monthStart(now, span - 1));
  const end = ymd(now);
  const query = `SELECT segments.date, metrics.cost_micros FROM customer `
    + `WHERE segments.date BETWEEN '${start}' AND '${end}'`;

  const headers = {
    authorization: `Bearer ${auth.token}`,
    'developer-token': c.developerToken,
    'content-type': 'application/json',
  };
  if (c.loginCustomerId) headers['login-customer-id'] = c.loginCustomerId;

  const url = `https://googleads.googleapis.com/${apiVersion()}`
    + `/customers/${c.customerId}/googleAds:searchStream`;

  let res;
  try {
    res = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify({ query }) });
  } catch (e) {
    log.error('google-ads searchStream failed:', e?.message || e);
    return { ok: false, error: 'REQUEST_FAILED' };
  }

  const text = await res.text();
  if (!res.ok) {
    // An expired access token shows up as 401 — drop the cache so the next
    // attempt re-exchanges rather than replaying the dead token.
    if (res.status === 401) resetTokenCache();
    log.error(`google-ads searchStream ${res.status}: ${text.slice(0, 200)}`);
    return { ok: false, error: `API_${res.status}` };
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, error: 'BAD_RESPONSE' };
  }

  // searchStream answers with an array of chunks, each holding `results`.
  const chunks = Array.isArray(payload) ? payload : [payload];
  const rows = chunks.flatMap((chunk) => chunk?.results || []);

  const byMonth = new Map();
  for (const row of rows) {
    const date = row?.segments?.date;
    if (typeof date !== 'string' || date.length < 7) continue;
    const month = date.slice(0, 7);
    const micros = Number(row?.metrics?.costMicros || 0);
    byMonth.set(month, (byMonth.get(month) || 0) + micros);
  }

  const out = Array.from(byMonth.entries())
    .map(([month, micros]) => ({ month, amountCents: microsToCents(micros) }))
    .sort((a, b) => (a.month < b.month ? 1 : -1));

  return { ok: true, months: out };
}
