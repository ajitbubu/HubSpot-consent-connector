-- HubSpot Consent Connector — connector-owned state only.
-- The consent ledger, effective state, identity, and review queues live in YOUR
-- consent platform. These tables cover transport bookkeeping the connector needs
-- to be restartable, idempotent, and loop-safe.

BEGIN;

-- Durable sync checkpoints (initial-load cursor, delta watermark, preference poll).
CREATE TABLE sync_checkpoint (
    tenant_id    text        NOT NULL,
    connector_id text        NOT NULL,
    job_type     text        NOT NULL,   -- INITIAL_LOAD | DELTA_SYNC | PREFERENCE_POLL
    cursor       text,                   -- paging cursor for INITIAL_LOAD ('DONE' when complete)
    watermark    timestamptz,            -- max observed source modification time for DELTA_SYNC
    updated_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, connector_id, job_type)
);

-- Webhook event dedup (durable; webhook delivery is at-least-once).
CREATE TABLE webhook_event_seen (
    tenant_id       text        NOT NULL,
    portal_id       text        NOT NULL,
    event_type      text        NOT NULL,
    source_event_id text        NOT NULL,
    received_at     timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, portal_id, event_type, source_event_id)
);

-- Last consent version applied per destination record — refuses stale writes.
CREATE TABLE destination_applied_version (
    tenant_id       text   NOT NULL,
    portal_id       text   NOT NULL,
    party_id        text   NOT NULL,
    purpose_code    text   NOT NULL,
    channel         text   NOT NULL,
    applied_version bigint NOT NULL,
    correlation_id  text   NOT NULL,
    PRIMARY KEY (tenant_id, portal_id, party_id, purpose_code, channel)
);

-- Delivery receipts for outbound writes (audit + retry state).
CREATE TABLE delivery_receipt (
    delivery_id           text        PRIMARY KEY,
    change_id             text        NOT NULL,   -- your platform's outbox/change ID
    destination_system    text        NOT NULL,
    destination_tenant_id text        NOT NULL,   -- HubSpot portal ID
    destination_record_id text        NOT NULL,
    consent_version       bigint      NOT NULL,
    status                text        NOT NULL,
    attempt_count         int         NOT NULL DEFAULT 0,
    delivered_at          timestamptz,
    response_code         int,
    detail                text,
    UNIQUE (destination_system, destination_tenant_id, change_id)
);

COMMIT;
