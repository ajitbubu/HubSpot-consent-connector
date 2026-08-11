/**
 * In-memory consent-platform stub — FOR TESTING AND LOCAL DEMOS ONLY.
 * Stands in for your real consent management DB / preference center so the
 * connector can be exercised end to end without external services. It applies
 * none of your platform's validation policy; it just records what it is given.
 */

import type {
  ConsentSignal,
  NormalizedIdentityRecord,
} from "../../domain/types.js";
import type {
  ConsentPlatformPort,
  PartyDestinationLookup,
  PartyResolution,
  SignalAck,
} from "../port.js";

export class InMemoryConsentPlatform implements ConsentPlatformPort, PartyDestinationLookup {
  /** partyId → HubSpot contact mapping, keyed as tenant|party|portal. */
  private readonly destinations = new Map<string, { contactId: string; email: string | null }>();
  /** contact source key → partyId. */
  private readonly parties = new Map<string, string>();
  readonly signals: ConsentSignal[] = [];
  private readonly seenKeys = new Set<string>();
  private partyCounter = 0;

  async resolveParty(record: NormalizedIdentityRecord): Promise<PartyResolution> {
    const key = `${record.portalId}|${record.contactId}`;
    let partyId = this.parties.get(key);
    if (!partyId) {
      partyId = `PARTY-${++this.partyCounter}`;
      this.parties.set(key, partyId);
      this.destinations.set(`${record.tenantId}|${partyId}|${record.portalId}`, {
        contactId: record.contactId,
        email: record.emailNormalized,
      });
    }
    return { outcome: "RESOLVED", partyId };
  }

  async submitSignal(signal: ConsentSignal): Promise<SignalAck> {
    if (this.seenKeys.has(signal.idempotencyKey)) {
      return { accepted: true, deduplicated: true };
    }
    this.seenKeys.add(signal.idempotencyKey);
    this.signals.push(signal);
    return { accepted: true, deduplicated: false };
  }

  async findHubSpotContact(
    tenantId: string,
    partyId: string,
    portalId: string,
  ): Promise<{ contactId: string; email: string | null } | null> {
    return this.destinations.get(`${tenantId}|${partyId}|${portalId}`) ?? null;
  }

  /** Test helper: pre-register a party ↔ contact mapping. */
  registerParty(
    tenantId: string,
    partyId: string,
    portalId: string,
    contactId: string,
    email: string | null,
  ): void {
    this.parties.set(`${portalId}|${contactId}`, partyId);
    this.destinations.set(`${tenantId}|${partyId}|${portalId}`, { contactId, email });
  }
}
