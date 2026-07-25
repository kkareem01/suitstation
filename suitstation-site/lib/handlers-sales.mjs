/**
 * Admin handlers for revenue tracking: booking sale amounts, monthly ad
 * spend, revenue/CAC stats, and the Google Ads offline-conversion CSV feed.
 * Split out of lib/handlers.mjs (which is already oversized).
 *
 * Auth model:
 * - booking-sale / ad-spend / ad-spend-set / revenue-stats: staff-guarded via
 *   verifyStaffAuth (password session cookie or Bearer STAFF_TOKEN). Inputs
 *   stay strictly validated on top of that.
 * - handleAdsConversionsFeed: HTTP Basic auth because Google Ads'
 *   scheduled-upload fetcher sends username/password, not a Bearer token.
 */

import { ensureBootstrapped } from './db.mjs';
import { verifyStaffAuth, staffUnauthorized } from './handlers.mjs';
import {
  recordBookingSale,
  upsertAdSpend,
  releaseAdSpendToAuto,
  listAdSpend,
  listConversionRows,
  getRevenueStats,
} from './sales-store.mjs';
import { runSyncAdSpend } from './cron.mjs';
import { buildAdsCsv } from './ads-feed.mjs';
import * as log from './log.mjs';

const BK_ID_RE = /^BK-[A-F0-9]+$/i;

function sendJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function getUrl(req) {
  return new URL(req.url, `http://${req.headers.host || 'localhost'}`);
}

// --- booking sale -------------------------------------------------------------

export async function handleAdminRecordBookingSale(req, res) {
  if (!verifyStaffAuth(req)) return staffUnauthorized(res);
  await ensureBootstrapped();
  const body = req.body || {};
  const id = typeof body.id === 'string' ? body.id : '';
  if (!id || !BK_ID_RE.test(id)) {
    return sendJson(res, 400, { ok: false, error: 'INVALID_ID' });
  }
  try {
    const result = await recordBookingSale(id, {
      amountCents: body.amountCents,
      notes: body.notes,
    });
    if (!result.ok) {
      const code = result.error === 'INVALID_AMOUNT' ? 400 : 404;
      return sendJson(res, code, { ok: false, error: result.error });
    }
    log.info(`booking ${id} sale recorded: ${body.amountCents} cents`);
    return sendJson(res, 200, { ok: true });
  } catch (e) {
    log.error('admin record booking sale crash', e?.message || e);
    return sendJson(res, 500, { ok: false, error: e?.message || 'CRASH' });
  }
}

// --- ad spend -------------------------------------------------------------------

export async function handleAdminListAdSpend(req, res) {
  if (!verifyStaffAuth(req)) return staffUnauthorized(res);
  await ensureBootstrapped();
  try {
    const spend = await listAdSpend();
    return sendJson(res, 200, { ok: true, spend });
  } catch (e) {
    log.error('admin list ad spend crash', e?.message || e);
    return sendJson(res, 500, { ok: false, error: e?.message || 'CRASH' });
  }
}

/**
 * Typing a figure pins the month as 'manual' so the nightly Google Ads sync
 * stops touching it. Posting { month, auto: true } releases that pin and
 * re-syncs immediately, which is the way back from a typo.
 */
export async function handleAdminSetAdSpend(req, res) {
  if (!verifyStaffAuth(req)) return staffUnauthorized(res);
  await ensureBootstrapped();
  const body = req.body || {};
  try {
    if (body.auto === true) {
      const released = await releaseAdSpendToAuto(body.month);
      if (!released.ok) return sendJson(res, 400, { ok: false, error: released.error });
      const sync = await runSyncAdSpend({ months: 12 });
      log.info(`ad spend ${body.month} released to auto`);
      return sendJson(res, 200, { ok: true, source: 'auto', sync });
    }

    const result = await upsertAdSpend(body.month, body.amountCents, { source: 'manual' });
    if (!result.ok) return sendJson(res, 400, { ok: false, error: result.error });
    log.info(`ad spend ${body.month} set to ${body.amountCents} cents (manual)`);
    return sendJson(res, 200, { ok: true, source: 'manual' });
  } catch (e) {
    log.error('admin set ad spend crash', e?.message || e);
    return sendJson(res, 500, { ok: false, error: e?.message || 'CRASH' });
  }
}

/** Pull fresh numbers on demand, so nobody has to wait for the nightly cron. */
export async function handleAdminSyncAdSpend(req, res) {
  if (!verifyStaffAuth(req)) return staffUnauthorized(res);
  await ensureBootstrapped();
  try {
    const result = await runSyncAdSpend({ months: 12 });
    if (!result.ok) {
      // Missing credentials is a configuration problem (503); anything else
      // is Google refusing or failing the call (502).
      const status = result.error === 'NOT_CONFIGURED' ? 503 : 502;
      return sendJson(res, status, { ok: false, error: result.error });
    }
    return sendJson(res, 200, result);
  } catch (e) {
    log.error('admin sync ad spend crash', e?.message || e);
    return sendJson(res, 500, { ok: false, error: e?.message || 'CRASH' });
  }
}

// --- revenue / CAC stats ---------------------------------------------------------

export async function handleAdminRevenueStats(req, res) {
  if (!verifyStaffAuth(req)) return staffUnauthorized(res);
  await ensureBootstrapped();
  const url = getUrl(req);
  const months = parseInt(url.searchParams.get('months') || '12', 10) || 12;
  try {
    const stats = await getRevenueStats(months);
    return sendJson(res, 200, { ok: true, months: stats });
  } catch (e) {
    log.error('admin revenue stats crash', e?.message || e);
    return sendJson(res, 500, { ok: false, error: e?.message || 'CRASH' });
  }
}

// --- Google Ads conversion feed ---------------------------------------------------

/**
 * Constant-time compare of two strings (mirrors verifyBearer's XOR loop).
 */
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function verifyFeedBasicAuth(req) {
  const user = process.env.ADS_FEED_USER;
  const pass = process.env.ADS_FEED_PASS;
  if (!user || !pass || user.length < 16 || pass.length < 16) return false;
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string' || !auth.startsWith('Basic ')) return false;
  let decoded;
  try {
    decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
  } catch (_) {
    return false;
  }
  const sep = decoded.indexOf(':');
  if (sep < 0) return false;
  const gotUser = decoded.slice(0, sep);
  const gotPass = decoded.slice(sep + 1);
  // Bitwise & (not &&) so both compares always run — keeps timing uniform.
  return safeEqual(gotUser, user) & safeEqual(gotPass, pass) ? true : false;
}

/**
 * Serves the click-conversions CSV that Google Ads fetches on a daily
 * schedule (Data Manager → scheduled upload from HTTPS URL + credentials).
 * Empty feeds still return the header rows — Google treats that as
 * "no conversions today", not an error.
 */
export async function handleAdsConversionsFeed(req, res) {
  if (!verifyFeedBasicAuth(req)) {
    res.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'www-authenticate': 'Basic realm="ads-feed"',
      'cache-control': 'no-store',
    });
    return res.end(JSON.stringify({ ok: false, error: 'UNAUTHORIZED' }));
  }
  await ensureBootstrapped();
  try {
    const rows = await listConversionRows();
    const csv = buildAdsCsv(rows);
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'cache-control': 'no-store',
    });
    return res.end(csv);
  } catch (e) {
    log.error('ads conversions feed crash', e?.message || e);
    return sendJson(res, 500, { ok: false, error: 'CRASH' });
  }
}
