/**
 * Change watcher — demonstrates incremental consent pull over a bounded run.
 *
 * Cycle 0 is the BASELINE: every current status becomes a signal once.
 * Each following cycle re-reads preference statuses; unchanged statuses produce
 * the SAME idempotency key and are deduplicated, so only real changes surface.
 * For the continuous version (plus the webhook channel), use live-sync.ts.
 *
 * Run: npx tsx scripts/watch-changes.ts [cycles] [intervalSeconds]
 */

import { InboundPipeline } from "../src/ingestion/pipeline.js";
import { InMemoryConsentPlatform } from "../src/platform/testing/in-memory-platform.js";
import { bootstrap, portalMappings, redactEmail } from "./_shared.js";

async function main(): Promise<void> {
  const cycles = Number(process.argv[2] ?? 6);
  const intervalSeconds = Number(process.argv[3] ?? 8);
  const { portalId, contactsApi, preferencesApi } = bootstrap();
  const mappings = portalMappings(portalId);

  // ONE platform instance across all cycles — its idempotency-key memory is what
  // turns "pull everything" into "surface only what changed".
  const platform = new InMemoryConsentPlatform();
  const pipeline = new InboundPipeline(preferencesApi, platform, {
    tenantId: "WATCH-TENANT",
    portalId,
    findMapping: (id) => mappings.get(id) ?? null,
  });

  const page = await contactsApi.fetchPage(undefined, 50);
  const watched = page.contacts.filter((c) => c.properties["email"]);
  console.log(`Watching ${watched.length} contact(s); ${cycles} cycles, every ${intervalSeconds}s.\n`);

  for (let cycle = 0; cycle < cycles; cycle++) {
    const before = platform.signals.length;
    await pipeline.processPage(watched);
    const fresh = platform.signals.slice(before);

    const stamp = new Date().toISOString().slice(11, 19);
    if (cycle === 0) {
      console.log(`[${stamp}] cycle 0 (baseline): captured ${fresh.length} current status(es)`);
    } else if (fresh.length === 0) {
      console.log(`[${stamp}] cycle ${cycle}: no changes`);
    } else {
      console.log(`[${stamp}] cycle ${cycle}: ${fresh.length} CHANGE(S) detected:`);
      for (const signal of fresh) {
        console.log(
          `    → ${redactEmail(signal.identity.emailNormalized)}  ${signal.purposeCode ?? "(unmapped)"}` +
            `  is now ${signal.status}  (party=${signal.partyId}, key=${signal.idempotencyKey.slice(0, 16)}…)`,
        );
      }
    }

    if (cycle < cycles - 1) await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
  }

  console.log(`\nDone. Total signals in platform: ${platform.signals.length}`);
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});
