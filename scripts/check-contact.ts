/**
 * Quick read-only check: print subscription statuses for one email.
 * Usage: npx tsx scripts/check-contact.ts someone@example.com
 */

import { bootstrap, redactEmail } from "./_shared.js";

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npx tsx scripts/check-contact.ts <email>");
    process.exit(1);
  }
  const { preferencesApi } = bootstrap();
  const prefs = await preferencesApi.fetchStatuses(email);

  console.log(`${redactEmail(email)} subscription statuses:`);
  for (const s of prefs.subscriptionStatuses) {
    console.log(
      `  [${s.id}] ${s.name}: ${s.status}` +
        (s.legalBasis ? `  legalBasis=${s.legalBasis}` : "") +
        (s.sourceOfStatus ? `  source=${s.sourceOfStatus}` : ""),
    );
  }
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});
