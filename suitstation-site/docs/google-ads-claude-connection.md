# Connecting Claude to Google Ads (so it can act as ads manager)

> **STATUS: CONNECTED as of 2026-07-17.** Basic access approved, OAuth
> complete, smoke test passed against live campaign data. Credentials live in
> `tools/ads/google-ads.yaml` (gitignored, chmod 600); scripts in
> `tools/ads/` (`authorize.py`, `smoke_test.py`, Python 3.10 venv at
> `tools/ads/.venv`). Note: API calls go **directly** to the ads account
> (532-289-6656) — the manager account (573-502-3366, "GA Suit Warehouse")
> is not yet linked to it, so `login_customer_id` is commented out in the
> yaml. Linking is optional; if done later, uncomment that line.

> **Owner-friendly version:** a click-by-click checklist of this doc (plus the
> conversion-tracking steps) lives at
> https://claude.ai/code/artifact/d03cee94-6365-4b37-81a1-118988c64a04 —
> it remembers your progress between sessions.

Claude cannot log into ads.google.com. To let it read performance data and
make changes directly, it needs Google Ads **API** access. One-time setup,
~30 min of clicking plus a 1–2 day wait for Google's approval.

## What you set up (one time)

### 1. Manager account + developer token (~10 min + approval wait)
1. Create a free Manager Account (MCC) at [ads.google.com/home/tools/manager-accounts](https://ads.google.com/home/tools/manager-accounts)
   — use the same Google login that owns the ads account.
2. In the manager account: **Admin → API Center** → apply for a developer
   token. Choose **Basic access** and describe the use as
   "reporting and campaign management for my own retail store account".
   Approval usually takes 1–2 business days.
3. From the manager account, send a **link request** to your existing
   Google Ads account (Accounts → + → Link existing account) and accept it
   from the ads account.

### 2. OAuth credentials (~10 min)
1. Go to [console.cloud.google.com](https://console.cloud.google.com) →
   create a project (e.g. `gasw-ads-api`).
2. **APIs & Services → Library** → search "Google Ads API" → **Enable**.
3. **Google Auth Platform** (left nav or search bar) → **Get started** wizard:
   - **App Information**: App name `GASW Ads API` (any label — only you see
     it on your own consent screen), User support email = your Gmail.
   - **Audience**: **External**.
   - **Contact Information**: your Gmail again.
   - Agree to the policy → **Create**.
4. Still in Google Auth Platform → **Audience** page → under Publishing
   status click **Publish app** → Confirm. (In "Testing" status Google
   expires refresh tokens every 7 days — publishing stops that. You'll see
   an "unverified app" warning when you authorize; that's expected and fine
   for your own app, click Advanced → continue.)
5. **Clients** (left nav) → **+ Create client** → Application type:
   **Desktop app** → name `claude-cli` → **Create** → copy the
   **Client ID** and **Client secret** (or download the JSON).

### 3. Hand the four values to Claude
Paste these into a Claude Code session (it will store them in a local
`google-ads.yaml`, never committed):

- Developer token (from step 1.2)
- OAuth client ID + client secret (from step 2.4)
- Customer IDs: the 10-digit ID of the ads account and of the manager account

Claude will then run the one-time OAuth flow (a browser window where you
click "Allow") to mint a refresh token, and from that point on it can pull
any report (search terms, asset groups, budgets, conversion diagnostics)
and stage changes (negative keywords, budget moves, conversion-goal edits)
on request — no more manual CSV exports.

## Until then: the CSV workflow works fine

Export any report from ads.google.com (Download → .csv) and drop it in the
project folder — Claude parses Google's UTF-16 exports directly. Most
useful exports: **Search terms**, **Campaigns**, **Asset groups**,
**Goals → Conversions summary**.

## Related

- Conversion-goal setup (the part Google needs to optimize for booked
  appointments): [ads-tracking-runbook.md](./ads-tracking-runbook.md) —
  steps 1–7 are still pending as of 2026-07-16.
