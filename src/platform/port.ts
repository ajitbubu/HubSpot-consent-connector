/**
 * The boundary between this connector and YOUR consent platform.
 *
 * Inbound:  the connector normalizes HubSpot changes into ConsentSignal and calls
 *           `submitSignal`. Your platform validates evidence, resolves identity
 *           authoritatively, appends to its ledger, and derives effective state.
 * Outbound: your platform (its outbox or preference center) calls the connector's
 *           delivery worker with ConsentStateChange commands.
 *
 * Implement this port against your consent management DB. An in-memory stub for
 * testing lives in src/platform/testing/in-memory-platform.ts.
 */

import type {
  ConsentSignal,
  NormalizedIdentityRecord,
} from "../domain/types.js";

export type PartyResolution =
  | { outcome: "RESOLVED"; partyId: string }
  | { outcome: "UNRESOLVED" }        // platform will resolve asynchronously
  | { outcome: "REVIEW" };           // ambiguous — platform queues it; marketing stays blocked

export type SignalAck =
  | { accepted: true; deduplicated: boolean }
  | { accepted: false; reason: string };

export interface ConsentPlatformPort {
  /**
   * Ask the platform to resolve a HubSpot contact to a party. The connector never
   * invents identity semantics: shared emails, duplicates, and merges are the
   * platform's judgment. May return UNRESOLVED — signals still flow with
   * partyId=null and the platform attaches them after resolution.
   */
  resolveParty(record: NormalizedIdentityRecord): Promise<PartyResolution>;

  /**
   * Deliver one normalized signal. Must be idempotent on signal.idempotencyKey.
   * The platform decides whether the signal qualifies as consent evidence.
   */
  submitSignal(signal: ConsentSignal): Promise<SignalAck>;
}

/**
 * Lookup the connector needs at delivery time: which HubSpot contact does a
 * party map to. Backed by your platform's identity mapping (or the connector's
 * own mapping table if you prefer to keep it connector-side).
 */
export interface PartyDestinationLookup {
  findHubSpotContact(
    tenantId: string,
    partyId: string,
    portalId: string,
  ): Promise<{ contactId: string; email: string | null } | null>;
}
