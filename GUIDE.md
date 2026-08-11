# HubSpot Consent Connector — Usage Guide

Step-by-step instructions for setting up, running, and demonstrating the
connector. The operating model:

```text
HubSpot (inbound) → Consent DB / Preference Center → Downstream (HubSpot)
```

Every step below was verified against a live portal. Commands run from the
project root (`HubSpot-consent-connector/`).

---

## 1. Prerequisites

- **Node.js ≥ 20** (`node --version`)
- A **HubSpot account** you can administer (a free developer test account works —
  create one at app.hubspot.com under your developer account → Testing)
- 10 minutes for first-time setup

```bash
npm install        # install dependencies
npm run typecheck  # should pass clean
npm test           # 34 unit tests, no network needed
```

---

## 2. One-time HubSpot setup

### 2.1 Create a Service Key (authentication)

HubSpot has deprecated private apps ("legacy apps"); **Service Keys** are the
current single-account path.

1. In your portal: **Settings (gear) → Development → Keys → Service Keys → Create service key**
2. Name it (e.g. `consent-connector`)
3. Add scopes — start read-only, add writes only when you enable those features:

| Scope | Needed for |
|---|---|
| `crm.objects.contacts.read` | Pulling contacts (step 4) |
| `communication_preferences.read` | Reading subscription statuses (step 4) |
| `crm.objects.contacts.write` | Seeding test data; outbound property writes (steps 3, 6) |
| `communication_preferences.write` | Seeding opt-ins/outs; outbound enforcement (steps 3, 6) |
| `crm.schemas.contacts.write` | Creating the connector's custom properties (step 2.3) |

4. **Create** → copy the token (`pat-…`). Scopes can be edited later (Edit → Add new scope → Save).

### 2.2 Configure the environment

```bash
cp .env.example .env
```

Edit `.env`:

```text
HUBSPOT_PRIVATE_APP_TOKEN=pat-na1-xxxx...     # the service key token
HUBSPOT_PORTAL_ID=12345678                    # Settings → Account (or the URL)
# HUBSPOT_APP_SECRET=...                      # only for the webhook channel (step 5)
```

`.env` is gitignored. The token is never logged by any script.

### 2.3 Create the connector's custom properties

Outbound delivery writes sync status + loop-prevention markers to contacts.
Create them once (idempotent):

```bash
npx tsx scripts/ensure-properties.ts
```

Creates the `consent_connector` property group with: `consent_party_id`,
`consent_sync_status`, `consent_version`, `consent_last_updated`,
`consent_source`, `consent_correlation_id`, `consent_updated_by`.

### 2.4 Find your subscription-type IDs

The connector maps HubSpot subscription types to consent purposes by **ID**.
Read them for any contact with an email:

```bash
npx tsx scripts/check-contact.ts someone@yourportal.com
```

Then adjust the mapping table in `scripts/_shared.ts` (`portalMappings`) to your
portal's IDs and your purpose codes. In production these mappings come from
tenant configuration (spec §5.1), not code.

---

## 3. (Optional) Seed test data

Creates 5 contacts covering every consent state — explicit opt-in, explicit
opt-out (grant→withdraw history), never-chose, global opt-out. Idempotent.

```bash
npm run seed
```

Edit the personas in `scripts/seed-test-data.ts` first (emails, and your
subscription-type IDs). Notes learned from live portals:

- **GDPR-enabled portals require a legal basis on every preference write**, including unsubscribes.
- **You cannot unsubscribe someone who never subscribed** — a true opt-out needs subscribe → unsubscribe.

---

## 4. Run the closed loop

### Step ① — HubSpot (inbound) → Consent DB

```bash
npx tsx scripts/sync-inbound.ts
```

Pulls contacts + native subscription statuses and appends consent events to the
persistent demo consent DB (`.consent-db.json`). Each event carries provenance,
a payload hash, and a deterministic idempotency key. Re-running appends only
new facts.

Interpretation policy (demo — your platform's validation replaces it):
`SUBSCRIBED → GRANTED`, `UNSUBSCRIBED → WITHDRAWN`, `NOT_SUBSCRIBED → UNKNOWN`
(ambiguous: "opted out" and "never chose" are indistinguishable in the status
API — never auto-record a withdrawal from it).

### Step ② — View records (Preference Center / Auditor)

```bash
npx tsx scripts/build-audit-view.ts
open audit-view.html
```

Shows, per person: current consent per purpose (derived, never edited), the
append-only event log with evidence (method, actor, notice version, source ref,
hashes), and downstream delivery receipts.

### Step ③ — Preference-center change → Downstream (HubSpot)

Simulate the person changing consent in your preference center:

```bash
npx tsx scripts/pc-change.ts ada@example.com WITHDRAWN EMAIL_MARKETING
```

This appends an evidenced event to the consent DB (actor, notice version,
correlation ID), emits the outbox change, delivers it through the real
`HubSpotDeliveryWorker` (native unsubscribe **first**, then the `consent_*`
properties), and stores the receipt. Verify:

```bash
npx tsx scripts/check-contact.ts ada@example.com   # native status flipped
npx tsx scripts/check-props.ts ada@example.com     # markers written
npx tsx scripts/build-audit-view.ts                # receipt visible
```

Note: **re-granting** after a self-service opt-out is refused by HubSpot's v3
API by design → the receipt shows `NOT_SUPPORTED`. That is correct behavior,
not a bug (spec §9.2).

---

## 5. Immediate change detection (inbound)

### Fast poll (works out of the box)

```bash
npx tsx scripts/live-sync.ts --interval 5
```

Baselines all statuses, then re-polls every 5s; only real changes reach the
consent DB (idempotency keys dedupe everything else). Test it: change a
subscription in the HubSpot UI, or:

```bash
npx tsx scripts/set-optin.ts cleo@example.com          # opt in (marketing)
npx tsx scripts/set-optin.ts cleo@example.com --out    # withdraw
```

Measured: change → consent DB in **2 seconds**.

One-shot change watching (N cycles, M seconds apart):

```bash
npx tsx scripts/watch-changes.ts 8 8
```

### Webhooks (instant, optional)

The receiver is built (`src/ingestion/webhook-controller.ts`); to activate it
you need what only a HubSpot **app** provides:

1. An app with webhook subscriptions (`contact.creation`, `contact.propertyChange`,
   `contact.merge`, `contact.deletion`, `contact.privacyDeletion`) — service keys
   cannot register webhooks.
2. The app secret in `.env` as `HUBSPOT_APP_SECRET`.
3. A public URL for `POST /webhooks/hubspot` (e.g. `ngrok http 8000` in dev)
   registered as the target.

Then `live-sync.ts` runs both channels; whichever sees a change first wins,
and the other's sighting deduplicates.

---

## 6. Command reference

| Command | Purpose |
|---|---|
| `npm test` / `npm run typecheck` | Unit tests (no network) / TypeScript check |
| `npm run smoke` | Read-only end-to-end smoke test against the portal |
| `npm run seed` | Create/refresh test contacts with consent states |
| `npx tsx scripts/sync-inbound.ts` | Inbound sync → consent DB |
| `npx tsx scripts/build-audit-view.ts` | Generate the audit/preference-center view |
| `npx tsx scripts/pc-change.ts <email> <GRANTED\|WITHDRAWN> [purpose]` | Preference-center change + downstream push |
| `npx tsx scripts/live-sync.ts [--interval N] [--port N]` | Continuous immediate sync (poll + webhook) |
| `npx tsx scripts/watch-changes.ts [cycles] [secs]` | Bounded change watcher |
| `npx tsx scripts/set-optin.ts <email> [typeId] [--out]` | Flip a subscription (simulate a person) |
| `npx tsx scripts/check-contact.ts <email>` | Spot-check native subscription statuses |
| `npx tsx scripts/check-props.ts <email>` | Spot-check connector properties on a contact |
| `npx tsx scripts/ensure-properties.ts` | Create custom properties (once) |

Local state files (all gitignored): `.env` (secrets), `.consent-db.json`
(demo consent DB), `audit-view.html` (generated view).

---

## 7. Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `401 Unauthorized` | Token wrong or revoked — re-copy from Service Keys; recreating a key mints a new token |
| `403 … required scopes` | Missing scope — edit the service key, add the scope from the table in 2.1, Save |
| `400 … Legal Basis is required` | GDPR portal — every preference write needs `legalBasis` + explanation (built into the connector; if you see it, you're calling the API directly) |
| Unsubscribe rejected on a fresh contact | v3 can't unsubscribe someone who never subscribed — subscribe first |
| `GRANTED` push returns `NOT_SUPPORTED` | v3 refuses re-subscribing a self-opted-out contact — correct fail-safe |
| `0 contacts` in smoke test | Portal is empty, or contacts lack emails — run `npm run seed` |
| Watcher shows no changes | The change didn't alter status (same value), or it deduplicated — check with `check-contact.ts` |
| Property write `400 PROPERTY_DOESNT_EXIST` | Run `npx tsx scripts/ensure-properties.ts` |

---

## 8. Going to production

The demo pieces and their production replacements:

| Demo piece | Production replacement |
|---|---|
| `.consent-db.json` (`FileConsentDb`) | Your consent platform behind `src/platform/port.ts` (`resolveParty`, `submitSignal`, destination lookup) |
| `audit-view.html` generator | Your preference center / IDP rendering the same data shapes |
| In-memory checkpoints & dedup | Postgres tables in `database/migrations/001_init.sql` |
| `scripts/live-sync.ts` process | Scheduled workers + webhook receiver behind a real HTTP service |
| Mappings in `scripts/_shared.ts` | Versioned, tenant-approved mapping profiles (spec §5.1) |
| Service key | OAuth app for multi-tenant installs (spec §4) |

The full requirements are in [`PRODUCTION-IMPLEMENTATION-SPEC.md`](./PRODUCTION-IMPLEMENTATION-SPEC.md);
flow diagrams in [`docs/architecture.md`](./docs/architecture.md); module map in
[`README.md`](./README.md).
