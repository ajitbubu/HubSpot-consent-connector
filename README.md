# HubSpot Consent Connector

**New here? Start with [`GUIDE.md`](./GUIDE.md) — step-by-step setup and usage.**

Bidirectional HubSpot connector for an **existing** consent management platform.
The connector owns transport, normalization, mapping, and delivery; **your**
platform owns identity, evidence validation, the consent ledger, effective state,
and the preference center. Built to
[`PRODUCTION-IMPLEMENTATION-SPEC.md`](./PRODUCTION-IMPLEMENTATION-SPEC.md)
(connector-scoped sections; platform-side sections apply to your platform).

```text
Inbound:   HubSpot (contacts, native email preferences, webhooks)
             → normalize → ConsentSignal → YOUR platform (via ConsentPlatformPort)

Outbound:  YOUR platform (outbox / preference center)
             → ConsentStateChange → delivery worker → HubSpot
               (native subscription status + visibility properties)
```

## The integration boundary — `src/platform/port.ts`

Implement two small interfaces against your consent DB:

- **`ConsentPlatformPort`** (inbound): `resolveParty(identityRecord)` and
  `submitSignal(signal)`. Signals carry provenance, ordering metadata, an
  idempotency key, and a payload hash — your platform decides what qualifies
  as consent.
- **`PartyDestinationLookup`** (outbound): party → HubSpot contact mapping used
  at delivery time.

Then feed your platform's consent changes to `HubSpotDeliveryWorker.deliver()` as
`ConsentStateChange` commands (monotonic `consentVersion` per party+purpose).

`src/platform/testing/in-memory-platform.ts` is a stub implementation of both
interfaces **for testing and local demos only** — swap it for your real adapters.

## Modules

| Area | Module |
|---|---|
| Auth (private app + OAuth refresh, fail-closed) | `src/auth/token-service.ts` |
| HTTP client (401 refresh, 429/backoff, redaction) | `src/hubspot/client.ts` |
| Contacts API (paged pull, delta search, patch) | `src/hubspot/contacts-api.ts` |
| Preferences API (email-keyed read, un/subscribe) | `src/hubspot/preferences-api.ts` |
| Webhook signature v3 + replay window | `src/hubspot/webhook-validator.ts` |
| Normalization → `ConsentSignal` | `src/ingestion/normalizer.ts` |
| Inbound pipeline (contacts → platform) | `src/ingestion/pipeline.ts` |
| Initial load (checkpointed pagination) | `src/ingestion/initial-load-worker.ts` |
| Delta sync (watermark + overlap) | `src/ingestion/delta-sync-worker.ts` |
| Delivery worker (version-aware, receipted) + loop prevention | `src/delivery/hubspot-writer.ts` |
| Platform boundary | `src/platform/port.ts` |
| Connector-owned schema (checkpoints, dedup, versions, receipts) | `database/migrations/001_init.sql` |

## Immediate change propagation

See [`docs/architecture.md`](./docs/architecture.md) for flow diagrams. Two
inbound channels run together (`scripts/live-sync.ts`): the webhook receiver
(`src/ingestion/webhook-controller.ts`, instant, needs `HUBSPOT_APP_SECRET` +
public URL) and a fast preference poll (≤ interval, catches footer
unsubscribes). Shared idempotency keys mean each real change reaches the
consent DB exactly once — measured live at 2s change→DB on a 5s poll.

## Not yet implemented

- Postgres adapters for `CheckpointStore`, `DeliveryStore`, and the webhook
  dedup store (ports are defined; tests use in-memory doubles; schema is in
  the migration).
- Durable queue between webhook receiver and worker (demo uses in-process).
- OAuth install/callback controller and connector health endpoint.
- Retry/DLQ loop around `deliver()` for `RETRYABLE_FAILURE` receipts.

## Develop

```bash
npm install
npm run typecheck
npm test
```

Tests are pure-unit (no network, no DB): HubSpot APIs are stubbed through the
injectable `FetchLike`/API interfaces, and the platform side runs against the
in-memory stub.

## Connector invariants

- Email is a matching attribute, never a record key — the source key is
  portal + object type + contact ID.
- `NOT_SPECIFIED` produces no signal: absence of an opt-out is never data.
- The connector asserts nothing about consent validity — that is your platform's
  validation policy; signals are facts with provenance and hashes.
- A stale `consentVersion` is never written to HubSpot (`STALE_VERSION_SKIPPED`).
- Custom properties never enforce email — native subscription status is always
  synchronized on delivery.
- The connector never creates HubSpot contacts (`CONTACT_NOT_FOUND` instead).
- Loop prevention is correlation + version + field based; the integration user is
  never blanket-ignored.
- The v3 preference API cannot resubscribe a previously opted-out contact — that
  rejection surfaces as `NOT_SUPPORTED`, it is never worked around.
