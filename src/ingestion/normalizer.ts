/**
 * Normalization — HubSpot contact + subscription statuses → ConsentSignal.
 * The connector reports facts with provenance and integrity hashes; whether a
 * fact qualifies as consent is the platform's decision. NOT_SPECIFIED statuses
 * produce nothing: absence of an opt-out is never a signal.
 */

import { createHash } from "node:crypto";
import type { HubSpotContact } from "../hubspot/contacts-api.js";
import type { SubscriptionStatus } from "../hubspot/preferences-api.js";
import type {
  ConsentSignal,
  MappingProfile,
  NormalizedIdentityRecord,
} from "../domain/types.js";

export function normalizeContact(
  tenantId: string,
  portalId: string,
  contact: HubSpotContact,
): NormalizedIdentityRecord {
  const props = contact.properties;
  return {
    tenantId,
    portalId,
    contactId: contact.id,
    consentPartyId: emptyToNull(props["consent_party_id"]),
    externalCustomerId: emptyToNull(props["external_customer_id"]),
    emailNormalized: normalizeEmail(props["email"]),
    phoneNormalized: normalizePhone(props["phone"]),
    firstName: emptyToNull(props["firstname"]),
    lastName: emptyToNull(props["lastname"]),
  };
}

export function payloadHash(payload: unknown): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/** Deterministic — the same source fact always yields the same key. */
export function buildSignalIdempotencyKey(input: {
  portalId: string;
  contactId: string;
  subscriptionTypeId: string;
  status: string;
  effectiveAt: string;
}): string {
  const material = [
    "HUBSPOT",
    input.portalId,
    input.contactId,
    input.subscriptionTypeId,
    input.status,
    input.effectiveAt,
  ].join(":");
  return "sig-" + createHash("sha256").update(material).digest("hex");
}

export function signalsFromSubscriptionStatuses(input: {
  identity: NormalizedIdentityRecord;
  partyId: string | null;
  statuses: SubscriptionStatus[];
  findMapping: (subscriptionTypeId: string) => MappingProfile | null;
  effectiveAt: string;
  observedAt: string;
}): ConsentSignal[] {
  const signals: ConsentSignal[] = [];

  for (const status of input.statuses) {
    if (status.status === "NOT_SPECIFIED") continue;

    const mapping = input.findMapping(status.id);
    signals.push({
      tenantId: input.identity.tenantId,
      partyId: input.partyId,
      identity: input.identity,
      status: status.status,
      purposeCode: mapping?.purposeCode ?? null,
      channel: "EMAIL",
      source: {
        system: "HUBSPOT",
        portalId: input.identity.portalId,
        objectType: "EMAIL_SUBSCRIPTION_STATUS",
        objectId: input.identity.contactId,
        subscriptionTypeId: status.id,
      },
      mapping: mapping
        ? { mappingProfileId: mapping.mappingProfileId, version: mapping.version }
        : null,
      effectiveAt: input.effectiveAt,
      observedAt: input.observedAt,
      idempotencyKey: buildSignalIdempotencyKey({
        portalId: input.identity.portalId,
        contactId: input.identity.contactId,
        subscriptionTypeId: status.id,
        status: status.status,
        effectiveAt: input.effectiveAt,
      }),
      payloadHash: payloadHash(status),
    });
  }
  return signals;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmed) ? trimmed : null;
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d+]/g, "");
  return digits.length >= 7 ? digits : null;
}

function emptyToNull(value: string | null | undefined): string | null {
  return value ? value : null;
}
