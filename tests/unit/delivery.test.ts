/**
 * OUTBOUND DELIVERY TESTS
 * -----------------------
 * Covers: src/delivery/hubspot-writer.ts (your consent platform → HubSpot)
 *
 * When a person changes consent in your preference center, your platform sends
 * the connector a ConsentStateChange command. The delivery worker must:
 *   1. find the HubSpot contact for the party,
 *   2. refuse stale versions (an old change must never overwrite a newer one),
 *   3. update HubSpot's NATIVE subscription status (the thing that actually
 *      stops emails) and then the visibility properties,
 *   4. write a delivery receipt either way.
 *
 * The harness() helper builds the worker with hand-rolled fakes that record
 * every HubSpot call, so each test can assert exactly what was (or wasn't)
 * written to HubSpot.
 */

import { describe, expect, it } from "vitest";
import {
  HubSpotDeliveryWorker,
  compareVersions,
  type DeliveryStore,
} from "../../src/delivery/hubspot-writer.js";
import { InMemoryConsentPlatform } from "../../src/platform/testing/in-memory-platform.js";
import { HubSpotApiError } from "../../src/hubspot/client.js";
import type { ContactsApi } from "../../src/hubspot/contacts-api.js";
import type { PreferencesApi } from "../../src/hubspot/preferences-api.js";
import type {
  ConsentStateChange,
  DeliveryReceipt,
  MappingProfile,
} from "../../src/domain/types.js";

// Purpose ↔ subscription-type mapping with writeback allowed (BIDIRECTIONAL).
const MAPPING: MappingProfile = {
  mappingProfileId: "hubspot-map-01",
  version: "1.0.0",
  portalId: "987654",
  businessUnitId: "0",
  subscriptionTypeId: "98765",
  purposeCode: "EMAIL_MARKETING",
  channel: "EMAIL",
  direction: "BIDIRECTIONAL",
};

// A ConsentStateChange as your platform's outbox would emit it. Defaults to a
// withdrawal at version 17; tests override fields to build other cases.
function change(overrides: Partial<ConsentStateChange> = {}): ConsentStateChange {
  return {
    changeId: "CHG-1",
    tenantId: "TENANT-100",
    partyId: "PARTY-9001",
    purposeCode: "EMAIL_MARKETING",
    channel: "EMAIL",
    effectiveStatus: "WITHDRAWN",
    effectiveAt: "2026-08-10T14:30:00Z",
    consentVersion: 17,
    originSystem: "PREFERENCE_CENTER",
    correlationId: "CORR-123",
    ...overrides,
  };
}

// Test harness. Options:
//   lastApplied     — pretend HubSpot already has this consent version applied
//   failPreferences — make every preference API call throw this HubSpot error
// Returns the worker plus the recording arrays the fakes append to.
function harness(options: { lastApplied?: number | null; failPreferences?: HubSpotApiError } = {}) {
  const propertyWrites: Array<{ contactId: string; properties: Record<string, string> }> = [];
  const unsubscribes: Array<{ email: string; subscriptionTypeId: string }> = [];
  const subscribes: Array<{ email: string; subscriptionTypeId: string }> = [];
  const receipts: DeliveryReceipt[] = [];
  const appliedVersions: number[] = [];

  // Fake CRM contacts API — records property PATCHes instead of calling HubSpot.
  const contactsApi = {
    updateProperties: async (contactId: string, properties: Record<string, string>) => {
      propertyWrites.push({ contactId, properties });
    },
  } as unknown as ContactsApi;

  // Fake preferences API — records native un/subscribe calls, or throws when a
  // test wants to simulate a HubSpot-side failure.
  const preferencesApi = {
    unsubscribe: async (email: string, subscriptionTypeId: string) => {
      if (options.failPreferences) throw options.failPreferences;
      unsubscribes.push({ email, subscriptionTypeId });
    },
    subscribe: async (email: string, subscriptionTypeId: string) => {
      if (options.failPreferences) throw options.failPreferences;
      subscribes.push({ email, subscriptionTypeId });
    },
  } as unknown as PreferencesApi;

  // Fake delivery store — stands in for the connector's Postgres tables
  // (destination_applied_version + delivery_receipt).
  const store: DeliveryStore = {
    lastAppliedVersion: async () => options.lastApplied ?? null,
    recordAppliedVersion: async (c) => {
      appliedVersions.push(c.consentVersion);
    },
    insertReceipt: async (receipt) => {
      receipts.push(receipt);
    },
  };

  // The in-memory platform provides the party → HubSpot contact lookup.
  // PARTY-9001 is pre-registered as contact 123456 with a known email.
  const platform = new InMemoryConsentPlatform();
  platform.registerParty("TENANT-100", "PARTY-9001", "987654", "123456", "a@example.test");

  const worker = new HubSpotDeliveryWorker(
    contactsApi,
    preferencesApi,
    platform,
    store,
    (purpose) => (purpose === "EMAIL_MARKETING" ? MAPPING : null),
    "987654",
    () => new Date("2026-08-10T15:00:00Z"), // fixed clock → assertable receipts
  );

  return { worker, propertyWrites, unsubscribes, subscribes, receipts, appliedVersions };
}

describe("outbound delivery (platform → HubSpot)", () => {
  // Happy path for a withdrawal. Order matters: the native unsubscribe is the
  // enforcement surface (custom properties alone don't stop HubSpot emails),
  // then the visibility properties including the loop-prevention markers
  // (consent_correlation_id, consent_version) are written, then the applied
  // version is recorded so a redelivery would be skipped.
  it("delivers a withdrawal: native unsubscribe first, then visibility properties", async () => {
    const h = harness();
    const receipt = await h.worker.deliver(change());

    expect(receipt.status).toBe("DELIVERED");
    expect(h.unsubscribes).toEqual([{ email: "a@example.test", subscriptionTypeId: "98765" }]);
    expect(h.propertyWrites).toHaveLength(1);
    expect(h.propertyWrites[0]!.properties).toMatchObject({
      consent_sync_status: "SYNCED",
      consent_version: "17",
      consent_correlation_id: "CORR-123",
      consent_updated_by: "CONSENT_PLATFORM",
    });
    expect(h.appliedVersions).toEqual([17]);
  });

  // Ordering protection: HubSpot already has version 18 applied, and version 17
  // arrives late (out-of-order queue delivery). The worker must refuse it and
  // touch nothing — otherwise an old grant could overwrite a newer withdrawal.
  it("skips stale versions without touching HubSpot", async () => {
    const h = harness({ lastApplied: 18 });
    const receipt = await h.worker.deliver(change({ consentVersion: 17 }));
    expect(receipt.status).toBe("STALE_VERSION_SKIPPED");
    expect(h.unsubscribes).toHaveLength(0);
    expect(h.propertyWrites).toHaveLength(0);
  });

  // Idempotent redelivery: the queue redelivers version 17 after it was already
  // applied. That's success ("DELIVERED"), not an error — but no duplicate
  // writes may hit HubSpot.
  it("acknowledges an equal version as already delivered (idempotent redelivery)", async () => {
    const h = harness({ lastApplied: 17 });
    const receipt = await h.worker.deliver(change({ consentVersion: 17 }));
    expect(receipt.status).toBe("DELIVERED");
    expect(h.propertyWrites).toHaveLength(0);
  });

  // The connector never provisions contacts. A party with no HubSpot mapping
  // gets a CONTACT_NOT_FOUND receipt for your platform to act on.
  it("returns CONTACT_NOT_FOUND for unmapped parties — never creates contacts", async () => {
    const h = harness();
    const receipt = await h.worker.deliver(change({ partyId: "PARTY-UNKNOWN" }));
    expect(receipt.status).toBe("CONTACT_NOT_FOUND");
  });

  // Writeback is gated by mapping direction. A purpose without an approved
  // writeback mapping must not be pushed to HubSpot at all.
  it("returns NOT_SUPPORTED when the purpose has no writeback mapping", async () => {
    const h = harness();
    const receipt = await h.worker.deliver(change({ purposeCode: "SALES_OUTREACH" }));
    expect(receipt.status).toBe("NOT_SUPPORTED");
    expect(h.propertyWrites).toHaveLength(0);
  });

  // HubSpot's v3 preference API rejects resubscribing someone who opted out
  // themselves (HTTP 400). That legal/API constraint must surface as
  // NOT_SUPPORTED — the connector never works around it.
  it("maps the v3 cannot-resubscribe rejection to NOT_SUPPORTED", async () => {
    const h = harness({ failPreferences: new HubSpotApiError(400, false, "resubscribe rejected") });
    const receipt = await h.worker.deliver(change({ effectiveStatus: "GRANTED" }));
    expect(receipt.status).toBe("NOT_SUPPORTED");
  });

  // Rate limiting (429) is transient: classify as RETRYABLE_FAILURE and — the
  // subtle part — do NOT record the applied version, so the retry is not
  // mistaken for a stale duplicate and skipped.
  it("classifies 429 as retryable and does not record the version", async () => {
    const h = harness({ failPreferences: new HubSpotApiError(429, true, "rate limited") });
    const receipt = await h.worker.deliver(change());
    expect(receipt.status).toBe("RETRYABLE_FAILURE");
    expect(h.appliedVersions).toHaveLength(0);
  });
});

// The pure version-comparison rule used by the worker above:
// newer → apply; equal → already done; older → stale, refuse.
describe("version comparison", () => {
  it("applies newer, skips equal, refuses older", () => {
    expect(compareVersions(17, 16)).toBe("APPLY");
    expect(compareVersions(19, 17)).toBe("APPLY"); // gaps are fine — platform state is authoritative
    expect(compareVersions(17, null)).toBe("APPLY"); // first delivery to this destination
    expect(compareVersions(17, 17)).toBe("SKIP_EQUAL");
    expect(compareVersions(16, 17)).toBe("STALE_VERSION_SKIPPED");
  });
});
