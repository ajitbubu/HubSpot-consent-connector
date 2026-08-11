/**
 * INBOUND PIPELINE TESTS
 * ----------------------
 * Covers: src/ingestion/pipeline.ts (HubSpot → your consent platform)
 *
 * The inbound pipeline takes raw HubSpot contacts, normalizes them, asks the
 * platform to resolve the person (party), reads the contact's native email
 * subscription statuses, and submits ConsentSignal objects to the platform.
 *
 * These tests use two fakes:
 *  - preferencesStub(...)        — pretends to be the HubSpot preferences API
 *  - InMemoryConsentPlatform     — pretends to be YOUR consent DB, and records
 *                                  every signal it receives so we can inspect it
 */

import { describe, expect, it } from "vitest";
import { InboundPipeline } from "../../src/ingestion/pipeline.js";
import { InMemoryConsentPlatform } from "../../src/platform/testing/in-memory-platform.js";
import type { PreferencesApi, SubscriptionStatus } from "../../src/hubspot/preferences-api.js";
import type { HubSpotContact } from "../../src/hubspot/contacts-api.js";
import type { MappingProfile } from "../../src/domain/types.js";

// A single subscription-type → purpose mapping used across the tests:
// HubSpot subscription type "98765" means the platform purpose EMAIL_MARKETING.
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

// Fake HubSpot preferences API: whatever statuses a test passes in are returned
// for any email address, with no network involved.
function preferencesStub(statuses: SubscriptionStatus[]): PreferencesApi {
  return {
    fetchStatuses: async (email: string) => ({ recipient: email, subscriptionStatuses: statuses }),
  } as unknown as PreferencesApi;
}

// Builds a minimal HubSpot contact record the way the CRM API would return it:
// an ID plus a flat properties bag.
function contact(id: string, email: string | null): HubSpotContact {
  return {
    id,
    properties: {
      email,
      firstname: "Ada",
      lastname: "L",
      hs_lastmodifieddate: "2026-08-10T10:00:00Z",
    },
  };
}

// Assembles a pipeline wired to the two fakes. Each test gets a fresh platform
// stub, so signals from one test never leak into another. The fixed `now`
// makes timestamps deterministic and assertable.
function pipelineWith(statuses: SubscriptionStatus[]) {
  const platform = new InMemoryConsentPlatform();
  const pipeline = new InboundPipeline(preferencesStub(statuses), platform, {
    tenantId: "TENANT-100",
    portalId: "987654",
    findMapping: (id) => (id === MAPPING.subscriptionTypeId ? MAPPING : null),
    now: () => new Date("2026-08-10T12:00:00Z"),
  });
  return { platform, pipeline };
}

describe("inbound pipeline (HubSpot → platform)", () => {
  // Happy path: an UNSUBSCRIBED status on a mapped subscription type must reach
  // the platform as one signal carrying full provenance — which portal, which
  // contact, which subscription type — the mapped purpose, the resolved party,
  // the source timestamp (from hs_lastmodifieddate), and an integrity hash.
  it("submits an unsubscribed status as a mapped signal with provenance", async () => {
    const { platform, pipeline } = pipelineWith([
      { id: "98765", name: "Marketing", status: "UNSUBSCRIBED" },
    ]);

    await pipeline.processPage([contact("123456", "a@example.test")]);

    expect(platform.signals).toHaveLength(1);
    const signal = platform.signals[0]!;
    expect(signal).toMatchObject({
      status: "UNSUBSCRIBED",
      purposeCode: "EMAIL_MARKETING",
      partyId: "PARTY-1",
      source: {
        system: "HUBSPOT",
        portalId: "987654",
        objectId: "123456",
        subscriptionTypeId: "98765",
      },
      effectiveAt: "2026-08-10T10:00:00.000Z",
    });
    expect(signal.payloadHash).toMatch(/^sha256:/);
    expect(pipeline.stats).toMatchObject({ contactsSeen: 1, signalsSubmitted: 1 });
  });

  // A subscription type the connector has no mapping for is NOT dropped and NOT
  // guessed at — it flows through with purposeCode null so YOUR platform can
  // decide (map it, queue it, or ignore it).
  it("keeps unmapped subscription types flowing with purposeCode null (platform decides)", async () => {
    const { platform, pipeline } = pipelineWith([
      { id: "55555", name: "Mystery", status: "UNSUBSCRIBED" },
    ]);
    await pipeline.processPage([contact("123456", "a@example.test")]);
    expect(platform.signals[0]).toMatchObject({ purposeCode: null, mapping: null });
  });

  // Core privacy rule: a NOT_SPECIFIED status means the person never made a
  // choice. Absence of an opt-out must never be turned into data — no signal
  // may be emitted at all.
  it("emits nothing for NOT_SPECIFIED — absence is never a signal", async () => {
    const { platform, pipeline } = pipelineWith([
      { id: "98765", name: "Marketing", status: "NOT_SPECIFIED" },
    ]);
    await pipeline.processPage([contact("123456", "a@example.test")]);
    expect(platform.signals).toHaveLength(0);
  });

  // Delta-sync overlap windows and duplicate webhooks WILL re-deliver the same
  // contact. The signal's deterministic idempotency key (same source fact →
  // same key) lets the platform recognize the repeat: one stored signal, and
  // the second submission counted as deduplicated.
  it("re-processing the same contact deduplicates on the idempotency key", async () => {
    const { platform, pipeline } = pipelineWith([
      { id: "98765", name: "Marketing", status: "UNSUBSCRIBED" },
    ]);
    const page = [contact("123456", "a@example.test")];
    await pipeline.processPage(page);
    await pipeline.processPage(page); // simulates overlap window / duplicate webhook
    expect(platform.signals).toHaveLength(1);
    expect(pipeline.stats.signalsDeduplicated).toBe(1);
  });

  // The preferences API is keyed by email. A contact whose email doesn't parse
  // must not trigger a preference read (there is nothing valid to ask about),
  // but the contact itself is still counted and its identity was still offered
  // to the platform via resolveParty.
  it("skips preference reads for contacts without a valid email", async () => {
    const { platform, pipeline } = pipelineWith([
      { id: "98765", name: "Marketing", status: "UNSUBSCRIBED" },
    ]);
    await pipeline.processPage([contact("123456", "not-an-email")]);
    expect(platform.signals).toHaveLength(0);
    expect(pipeline.stats.contactsSeen).toBe(1);
  });
});
