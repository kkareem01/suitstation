/**
 * Repository for revenue data: per-booking sale amounts, monthly ad spend,
 * and the rows feeding the Google Ads offline-conversion CSV. Follows the
 * same conventions as lib/store.mjs / special-orders-store.
 *
 * Booked appointments only — the owner tracks ROI on bookings, where the
 * gclid gives accurate ad attribution; untrackable walk-in traffic is
 * deliberately excluded from revenue/CAC.
 *
 * Money is stored as INTEGER cents everywhere. On bookings,
 * sale_amount_cents NULL = "not recorded yet" and 0 = "came in, bought
 * nothing" — the distinction drives both the dashboard filters and the
 * conversion feed (only > 0 is a conversion).
 */

import { getDb } from './db.mjs';

export const MAX_SALE_CENTS = 5_000_000; // $50,000 — sanity cap for typos

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

function normalizeAmountCents(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > MAX_SALE_CENTS) return null;
  return n;
}

// --- booking sales ----------------------------------------------------------

/**
 * Record (or edit) how much a booked customer spent. sale_recorded_at is
 * write-once via COALESCE: it is part of Google Ads' offline-conversion dedup
 * key (gclid + conversion name + time), so a later amount edit must never
 * shift it or the edited row would upload as a *second* conversion.
 * @returns { ok: true } | { ok: false, error: 'INVALID_AMOUNT'|'NOT_FOUND' }
 */
export async function recordBookingSale(id, { amountCents, notes } = {}) {
  const amount = normalizeAmountCents(amountCents);
  if (amount === null) return { ok: false, error: 'INVALID_AMOUNT' };
  const cleanNotes = typeof notes === 'string' ? notes.trim().slice(0, 500) : '';

  const db = getDb();
  const result = await db.execute({
    sql: `UPDATE bookings
          SET sale_amount_cents = ?,
              sale_notes = ?,
              sale_recorded_at = COALESCE(sale_recorded_at, ?)
          WHERE id = ?`,
    args: [amount, cleanNotes, new Date().toISOString(), id],
  });
  if (result.rowsAffected === 0) return { ok: false, error: 'NOT_FOUND' };
  return { ok: true };
}

// --- ad spend ----------------------------------------------------------------

/**
 * Write a month's ad spend.
 *
 * `source` records who put the number there: 'manual' when someone typed it in
 * the dashboard, 'auto' when the Google Ads sync wrote it. A 'manual' row is
 * treated as the owner overriding Google, so syncAdSpendMonths leaves it be.
 *
 * @returns { ok: true } | { ok: false, error: 'INVALID_MONTH'|'INVALID_AMOUNT' }
 */
export async function upsertAdSpend(month, amountCents, { source = 'manual' } = {}) {
  if (typeof month !== 'string' || !MONTH_RE.test(month)) {
    return { ok: false, error: 'INVALID_MONTH' };
  }
  const amount = normalizeAmountCents(amountCents);
  if (amount === null) return { ok: false, error: 'INVALID_AMOUNT' };
  const src = source === 'auto' ? 'auto' : 'manual';

  const now = new Date().toISOString();
  const db = getDb();
  await db.execute({
    sql: `INSERT INTO ad_spend (month, amount_cents, updated_at, source, synced_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(month) DO UPDATE SET amount_cents = excluded.amount_cents,
                                           updated_at   = excluded.updated_at,
                                           source       = excluded.source,
                                           synced_at    = excluded.synced_at`,
    args: [month, amount, now, src, src === 'auto' ? now : null],
  });
  return { ok: true };
}

export async function listAdSpend(limit = 24) {
  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT * FROM ad_spend ORDER BY month DESC LIMIT ?',
    args: [Math.max(1, Math.min(120, Number(limit) || 24))],
  });
  return result.rows.map((r) => ({
    month: r.month,
    amountCents: Number(r.amount_cents),
    updatedAt: r.updated_at,
    source: r.source || 'auto',
    syncedAt: r.synced_at || null,
  }));
}

/**
 * Drop a month's manual pin so the Google Ads sync owns it again. A month with
 * no row yet is already auto by definition, so this is a no-op there.
 *
 * @returns { ok: true } | { ok: false, error: 'INVALID_MONTH' }
 */
export async function releaseAdSpendToAuto(month) {
  if (typeof month !== 'string' || !MONTH_RE.test(month)) {
    return { ok: false, error: 'INVALID_MONTH' };
  }
  const db = getDb();
  await db.execute({
    sql: `UPDATE ad_spend SET source = 'auto' WHERE month = ?`,
    args: [month],
  });
  return { ok: true };
}

/**
 * Apply figures pulled from the Google Ads API, skipping any month whose row
 * was typed by hand. Idempotent: re-running with the same numbers is a no-op
 * beyond refreshing synced_at.
 *
 * @param {Array<{month: string, amountCents: number}>} rows
 * @returns {Promise<{updated: string[], skipped: string[], unchanged: string[]}>}
 */
export async function syncAdSpendMonths(rows) {
  const db = getDb();
  const existing = await db.execute('SELECT month, amount_cents, source FROM ad_spend');
  const bySource = new Map(
    existing.rows.map((r) => [r.month, { source: r.source || 'auto', amountCents: Number(r.amount_cents) }])
  );

  const updated = [];
  const skipped = [];
  const unchanged = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const month = row?.month;
    if (typeof month !== 'string' || !MONTH_RE.test(month)) continue;
    const amount = normalizeAmountCents(row.amountCents);
    if (amount === null) continue;

    const prior = bySource.get(month);
    if (prior && prior.source === 'manual') {
      skipped.push(month);
      continue;
    }
    if (prior && prior.amountCents === amount) {
      // Same figure — still stamp synced_at so "last synced" stays truthful
      // for a closed-out month whose total no longer moves.
      await db.execute({
        sql: `UPDATE ad_spend SET synced_at = ? WHERE month = ? AND source = 'auto'`,
        args: [new Date().toISOString(), month],
      });
      unchanged.push(month);
      continue;
    }
    const res = await upsertAdSpend(month, amount, { source: 'auto' });
    if (res.ok) updated.push(month);
  }

  return { updated, skipped, unchanged };
}

// --- Google Ads offline-conversion feed rows ----------------------------------

/**
 * Bookings that count as an uploadable click conversion: ad-attributed
 * (gclid present — gbraid/wbraid can't ride the CSV click-conversion format),
 * with a recorded sale > 0, inside Google's 90-day click-conversion window.
 * Re-serving the same rows every day is safe: Google dedups uploads on
 * gclid + conversion name + conversion time, and sale_recorded_at is
 * write-once (see recordBookingSale).
 */
export async function listConversionRows() {
  const db = getDb();
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString();
  const result = await db.execute({
    sql: `SELECT gclid, sale_amount_cents, sale_recorded_at
          FROM bookings
          WHERE gclid IS NOT NULL
            AND sale_amount_cents > 0
            AND sale_recorded_at >= ?
          ORDER BY sale_recorded_at ASC`,
    args: [cutoff],
  });
  return result.rows.map((r) => ({
    gclid: r.gclid,
    amountCents: Number(r.sale_amount_cents),
    recordedAt: r.sale_recorded_at,
  }));
}

// --- monthly revenue / CAC stats ----------------------------------------------

/**
 * Merge per-month aggregates for the staff stats dashboard.
 * customers = booked appointments with a recorded sale > 0 (walk-ins are
 * deliberately excluded — no gclid means no accurate ad attribution, and the
 * owner tracks booked-appointment ROI only). aov/cac are null when their
 * denominator is 0.
 * @returns [{ month, spendCents, bookingsCreated, gclidBookings, showed,
 *             customers, revenueCents, aovCents, cacCents }] newest first
 */
export async function getRevenueStats(months = 12) {
  const n = Math.max(1, Math.min(36, Number(months) || 12));
  const db = getDb();

  const [created, showedUp, apptSales, spend] = await Promise.all([
    db.execute(`SELECT substr(created_at, 1, 7) AS month,
                       COUNT(*) AS bookings,
                       SUM(CASE WHEN gclid IS NOT NULL THEN 1 ELSE 0 END) AS gclid_bookings
                FROM bookings GROUP BY month`),
    // Everyone who actually came in — whether they bought (closed) or not
    // (showed) — grouped by appointment date.
    db.execute(`SELECT substr(slot_date, 1, 7) AS month, COUNT(*) AS showed
                FROM bookings WHERE staff_status IN ('showed', 'closed') GROUP BY month`),
    // Customers/revenue also group by APPOINTMENT date, not by when staff
    // typed the amount in — back-filling an old appointment's sale must
    // credit the month the customer actually came, or every entry piles into
    // the month it was typed. (The Google Ads feed is different: it keys on
    // sale_recorded_at, which is the conversion timestamp Google dedups on.)
    db.execute(`SELECT substr(slot_date, 1, 7) AS month,
                       COUNT(*) AS customers,
                       SUM(sale_amount_cents) AS revenue
                FROM bookings WHERE sale_amount_cents > 0 GROUP BY month`),
    db.execute('SELECT month, amount_cents, source, synced_at FROM ad_spend'),
  ]);

  const monthsMap = new Map();
  const monthRow = (month) => {
    if (!monthsMap.has(month)) {
      monthsMap.set(month, {
        month,
        spendCents: null,
        spendSource: null,
        spendSyncedAt: null,
        bookingsCreated: 0,
        gclidBookings: 0,
        showed: 0,
        customers: 0,
        revenueCents: 0,
      });
    }
    return monthsMap.get(month);
  };

  for (const r of created.rows) {
    const row = monthRow(r.month);
    row.bookingsCreated = Number(r.bookings);
    row.gclidBookings = Number(r.gclid_bookings || 0);
  }
  for (const r of showedUp.rows) {
    monthRow(r.month).showed = Number(r.showed);
  }
  for (const r of apptSales.rows) {
    const row = monthRow(r.month);
    row.customers += Number(r.customers);
    row.revenueCents += Number(r.revenue || 0);
  }
  for (const r of spend.rows) {
    const row = monthRow(r.month);
    row.spendCents = Number(r.amount_cents);
    row.spendSource = r.source || 'auto';
    row.spendSyncedAt = r.synced_at || null;
  }

  return Array.from(monthsMap.values())
    .filter((row) => MONTH_RE.test(row.month || ''))
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .slice(0, n)
    .map((row) => ({
      ...row,
      aovCents: row.customers > 0 ? Math.round(row.revenueCents / row.customers) : null,
      cacCents: row.customers > 0 && row.spendCents != null
        ? Math.round(row.spendCents / row.customers)
        : null,
    }));
}
