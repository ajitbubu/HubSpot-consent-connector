# Architecture & Flow

Rendered version with full diagrams: see the published artifact
("HubSpot Consent Connector — Architecture & Flow"). This file is the
repo-side reference.

## The closed loop (verified live)

Operating model: **HubSpot (inbound) → Consent DB / Preference Center → Downstream (HubSpot)**.

```mermaid
flowchart LR
    HS[HubSpot portal] -- "① inbound sync<br/>webhook <1s / poll ≤5s<br/>16 events appended" --> DB[(Consent DB<br/>append-only · evidence<br/>hashes · versions · receipts)]
    DB -- "records · log · evidence<br/>(derived state, never edited)" --> PC[Preference Center / Audit view<br/>👤 person · 🔍 auditor]
    PC -- "② person withdraws<br/>event vN + actor + notice → outbox" --> DW[Delivery worker<br/>version gate · native write first]
    DW -- "③ DELIVERED HTTP 200<br/>native unsubscribe + properties" --> HS
    DW -. "receipt stored" .-> DB
```

Verified end to end on Aug 10, 2026: inbound sync (16 events, 2s latency),
preference-center withdrawal (v3 with actor + notice version), downstream
delivery (HTTP 200, native status flipped), receipt in the consent DB, all
visible in the audit view (`scripts/build-audit-view.ts`).

## System overview

```mermaid
flowchart LR
    subgraph HS[HubSpot portal]
        WH[Webhooks: contact events]
        API[Contacts + Preferences APIs]
        NAT[Native subscriptions + consent_* properties]
    end
    subgraph CONN[Connector]
        UP[UPSTREAM inbound<br/>receiver · poll · delta · initial load<br/>normalize → resolve party → idempotency key]
        DOWN[DOWNSTREAM outbound<br/>delivery worker · version gate · receipts]
    end
    subgraph PLAT[Consent platform - yours]
        PORT[Platform port · validation]
        DB[(Consent DB · immutable events)]
        PC[Preference center → outbox]
    end
    WH -- "event <1s" --> UP
    API -- "poll ≤ interval" --> UP
    UP -- "ConsentSignal (provenance + hash + key)" --> PORT
    PORT --> DB
    PC -- "ConsentStateChange vN" --> DOWN
    DOWN -- "1. native unsubscribe (legal basis)<br/>2. properties + correlation ID" --> NAT
    NAT -. "echo webhook — dropped when correlation +<br/>version + fields match a completed delivery" .-> UP
```

## Inbound: change in HubSpot → consent DB, immediately

```mermaid
flowchart LR
    C[Change in HubSpot<br/>opt-in / unsubscribe] --> W[Webhook channel<br/>v3 signature · replay window · dedupe · fast-ack · <1s]
    C --> P[Fast-poll channel<br/>≤ interval, catches footer unsubscribes]
    W --> F[Fetch full contact<br/>webhook payloads are partial]
    P --> F
    F --> G{Same idempotency<br/>key seen before?}
    G -- yes --> D[Drop — unchanged status,<br/>duplicate webhook, overlap window]
    G -- no --> S[submitSignal → Consent DB]
```

Measured live: change at 23:46:22 → consent DB at 23:46:24 (**2 seconds**, 5s poll interval).

Whichever channel sees a change first wins; the shared deterministic key
(portal + contact + subscription type + status + timestamp) means the other
channel's sighting deduplicates — the consent DB receives each real change
**exactly once**. Delta sync (watermark + overlap) and reconciliation backstop
both channels, so a missed event is caught on the next sweep, never lost.

## Outbound: consent DB change → HubSpot, safely

```mermaid
flowchart LR
    PC[Withdrawal in<br/>preference center] --> OB[Outbox row<br/>same DB transaction]
    OB -- vN --> VG{Version gate}
    VG -- "older" --> SK[STALE_VERSION_SKIPPED<br/>old change never overwrites newer state]
    VG -- "equal" --> ACK[Ack — already delivered]
    VG -- "newer" --> N1[1 · Native unsubscribe<br/>enforcement surface · GDPR legal basis]
    N1 --> N2[2 · consent_* properties<br/>version · correlation ID · SYNCED]
    N2 --> R[Delivery receipt]
```

Verified live: `WITHDRAWN v1 → DELIVERED (HTTP 200)`, native status flipped,
loop-prevention markers written.

Write order matters: the native subscription is the surface that actually
stops email — custom properties alone enforce nothing — so it is written first.
The properties then carry the correlation ID that the inbound echo-check uses.

## Key modules

| Flow step | Module |
|---|---|
| Webhook receiver + dedup + fast-ack | `src/ingestion/webhook-controller.ts` |
| Poll / delta / initial load | `src/ingestion/*-worker.ts`, `scripts/live-sync.ts` |
| Normalize → signal + idempotency key | `src/ingestion/normalizer.ts`, `pipeline.ts` |
| Platform boundary | `src/platform/port.ts` |
| Delivery worker + version gate + echo check | `src/delivery/hubspot-writer.ts` |
