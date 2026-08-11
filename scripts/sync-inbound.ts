/**
 * Stage 1 of the closed loop: HubSpot (inbound) → Consent DB.
 * Pulls contacts + native subscription statuses and appends consent events
 * (with provenance + evidence hashes) to the persistent .consent-db.json.
 * Idempotent: re-running appends only new facts.
 *
 * Run: npx tsx scripts/sync-inbound.ts
 */

import { InboundPipeline } from "../src/ingestion/pipeline.js";
import { bootstrap, portalMappings, redactEmail } from "./_shared.js";

async function main(): Promise<void> {
  const { portalId, contactsApi, preferencesApi, consentDb } = bootstrap();
  const mappings = portalMappings(portalId);

  const pipeline = new InboundPipeline(preferencesApi, consentDb, {
    tenantId: "TENANT-DEMO",
    portalId,
    findMapping: (id) => mappings.get(id) ?? null,
  });

  console.log("→ HubSpot (inbound) → Consent DB");
  const page = await contactsApi.fetchPage(undefined, 50);
  const before = consentDb.snapshot().events.length;
  await pipeline.processPage(page.contacts.filter((c) => c.properties["email"]));
  const events = consentDb.snapshot().events;

  console.log(
    `✓ ${pipeline.stats.contactsSeen} contacts scanned · ` +
      `${events.length - before} new consent event(s) appended · ` +
      `${pipeline.stats.signalsDeduplicated} unchanged (deduplicated)`,
  );

  for (const event of events.slice(before)) {
    const party = consentDb.snapshot().parties[event.partyId];
    console.log(
      `   + ${redactEmail(party?.emailNormalized)}  ${event.purposeCode ?? "(unmapped)"} ` +
        `${event.status} → ${event.derivedStatus}  v${event.consentVersion}  [${event.origin}]`,
    );
  }
  console.log(`\nConsent DB now holds ${events.length} event(s) across ${Object.keys(consentDb.snapshot().parties).length} parties (.consent-db.json)`);
  console.log("View it: npx tsx scripts/build-audit-view.ts");
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});
