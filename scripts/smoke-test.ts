/**
 * READ-ONLY smoke test against a real HubSpot portal.
 *
 * What it does (no writes anywhere):
 *   1. Authenticates with the service-key token from .env.
 *   2. Pulls the first page of contacts through the real Contacts API.
 *   3. Reads native email subscription statuses.
 *   4. Runs both through the inbound pipeline → prints the ConsentSignals that
 *      would be submitted to your consent platform (in-memory stub here).
 *
 * Run: npm run smoke
 */

import { InboundPipeline } from "../src/ingestion/pipeline.js";
import { InMemoryConsentPlatform } from "../src/platform/testing/in-memory-platform.js";
import { bootstrap, portalMappings, redactEmail } from "./_shared.js";

async function main(): Promise<void> {
  const { portalId, contactsApi, preferencesApi } = bootstrap();

  console.log("→ Pulling first page of contacts (limit 10, read-only)…");
  const page = await contactsApi.fetchPage(undefined, 10);
  console.log(
    `✓ Auth OK. Retrieved ${page.contacts.length} contact(s); more pages: ${page.nextCursor !== undefined}`,
  );

  for (const contact of page.contacts) {
    console.log(
      `   contact ${contact.id}  email=${redactEmail(contact.properties["email"] ?? null)}` +
        `  modified=${contact.properties["lastmodifieddate"] ?? contact.properties["hs_lastmodifieddate"] ?? "?"}`,
    );
  }
  if (page.contacts.length === 0) {
    console.log("Portal has no contacts — run `npm run seed` and rerun.");
    return;
  }

  const withEmail = page.contacts.filter((c) => c.properties["email"]).slice(0, 10);
  console.log(`\n→ Reading native subscription statuses for ${withEmail.length} contact(s)…`);
  for (const contact of withEmail) {
    const prefs = await preferencesApi.fetchStatuses(contact.properties["email"]!);
    console.log(`✓ ${redactEmail(contact.properties["email"])}:`);
    for (const s of prefs.subscriptionStatuses) {
      console.log(`   [${s.id}] ${s.name}: ${s.status}`);
    }
  }

  console.log("\n→ Running the inbound pipeline (normalize → resolve party → signals)…");
  const platform = new InMemoryConsentPlatform();
  const mappings = portalMappings(portalId);
  const pipeline = new InboundPipeline(preferencesApi, platform, {
    tenantId: "SMOKE-TENANT",
    portalId,
    findMapping: (id) => mappings.get(id) ?? null,
  });
  await pipeline.processPage(withEmail);

  console.log(`✓ Pipeline stats: ${JSON.stringify(pipeline.stats)}`);
  console.log(`✓ ${platform.signals.length} ConsentSignal(s) would be submitted to your platform:`);
  for (const signal of platform.signals) {
    console.log(
      `   party=${signal.partyId} subscriptionType=${signal.source.subscriptionTypeId}` +
        ` status=${signal.status} purpose=${signal.purposeCode ?? "(unmapped)"}` +
        ` key=${signal.idempotencyKey.slice(0, 16)}…`,
    );
  }

  console.log("\nSmoke test complete — no writes were made to HubSpot.");
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});
