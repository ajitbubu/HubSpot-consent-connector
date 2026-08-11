/**
 * Connector domain types.
 * The connector owns transport, normalization, mapping, and delivery. The consent
 * platform (external — you already have one) owns identity, evidence validation,
 * the ledger, and effective state. Everything platform-side is reached through
 * the port in src/platform/port.ts.
 */

export type Channel = "EMAIL";

/**
 * Passed through from HubSpot verbatim. NOT_SUBSCRIBED is ambiguous (opted out
 * OR never chose) — the connector does not reinterpret it; your platform's
 * validation policy decides what it means.
 */
export type SignalStatus = "SUBSCRIBED" | "UNSUBSCRIBED" | "NOT_SUBSCRIBED";

/** Source key: portal + object type + record ID. Email is never a record key. */
export interface SourceRef {
  system: "HUBSPOT";
  portalId: string;
  objectType: "CONTACT" | "EMAIL_SUBSCRIPTION_STATUS";
  objectId: string;
  subscriptionTypeId?: string;
  sourceEventId?: string;
}

/**
 * Subscription-type ↔ purpose mapping (connector configuration, per tenant).
 * `direction` gates which way changes flow for that purpose.
 */
export interface MappingProfile {
  mappingProfileId: string;
  version: string;
  portalId: string;
  businessUnitId: string;
  subscriptionTypeId: string;
  purposeCode: string;
  channel: Channel;
  direction: "INBOUND" | "OUTBOUND" | "BIDIRECTIONAL";
}

/** Identity attributes the connector extracts for the platform to resolve. */
export interface NormalizedIdentityRecord {
  tenantId: string;
  portalId: string;
  contactId: string;
  consentPartyId: string | null;
  externalCustomerId: string | null;
  emailNormalized: string | null;
  phoneNormalized: string | null;
  firstName: string | null;
  lastName: string | null;
}

/**
 * Inbound payload handed to the platform. The connector asserts nothing about
 * whether this is valid consent — that judgment belongs to the platform's
 * validation service. The connector guarantees provenance, integrity hash,
 * ordering metadata, and idempotency key.
 */
export interface ConsentSignal {
  tenantId: string;
  /** Platform party ID when resolution succeeded; null lets the platform resolve/queue. */
  partyId: string | null;
  identity: NormalizedIdentityRecord;
  status: SignalStatus;
  /** Mapped purpose, or null when no approved mapping exists (platform decides handling). */
  purposeCode: string | null;
  channel: Channel;
  source: SourceRef;
  mapping: Pick<MappingProfile, "mappingProfileId" | "version"> | null;
  /** ISO timestamp of the source change, for platform-side ordering. */
  effectiveAt: string;
  observedAt: string;
  /** Deterministic — same source fact, same key. Platform dedupes on it. */
  idempotencyKey: string;
  /** sha256 over the raw source payload for tamper evidence. */
  payloadHash: string;
}

/**
 * Outbound command from the platform (its outbox / preference center) telling the
 * connector to update HubSpot. `consentVersion` must be monotonically increasing
 * per (party, purpose) so the connector can refuse stale writes.
 */
export interface ConsentStateChange {
  changeId: string;
  tenantId: string;
  partyId: string;
  purposeCode: string;
  channel: Channel;
  effectiveStatus: "GRANTED" | "WITHDRAWN" | "SUPPRESSED";
  effectiveAt: string;
  consentVersion: number;
  /** System that originated the change (loop prevention skips HubSpot echoes only). */
  originSystem: string;
  correlationId: string;
}

export type DeliveryStatus =
  | "DELIVERED"
  | "CONTACT_NOT_FOUND"
  | "RETRYABLE_FAILURE"
  | "PERMANENT_FAILURE"
  | "STALE_VERSION_SKIPPED"
  | "NOT_SUPPORTED";

export interface DeliveryReceipt {
  deliveryId: string;
  changeId: string;
  destinationSystem: "HUBSPOT";
  destinationTenantId: string;
  destinationRecordId: string;
  consentVersion: number;
  status: DeliveryStatus;
  attemptCount: number;
  deliveredAt?: string;
  responseCode?: number;
  detail?: string;
}
