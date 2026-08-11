/**
 * Set an explicit opt-in (or opt-out) for a contact's subscription type —
 * simulates a person granting/withdrawing consent in HubSpot.
 *
 * Usage:
 *   npx tsx scripts/set-optin.ts <email> [subscriptionTypeId] [--out]
 *
 * Defaults to subscribing to Marketing Information (3356897882).
 * GDPR portals require a legal basis on every preference write.
 */

import { bootstrap, redactEmail } from "./_shared.js";

async function main(): Promise<void> {
  const email = process.argv[2];
  const subscriptionId = process.argv.find((a, i) => i >= 3 && /^\d+$/.test(a)) ?? "3356897882";
  const optOut = process.argv.includes("--out");

  if (!email) {
    console.error("Usage: npx tsx scripts/set-optin.ts <email> [subscriptionTypeId] [--out]");
    process.exit(1);
  }

  const { client } = bootstrap();
  const endpoint = optOut
    ? "/communication-preferences/v3/unsubscribe"
    : "/communication-preferences/v3/subscribe";

  await client.post(endpoint, {
    emailAddress: email,
    subscriptionId,
    legalBasis: "CONSENT_WITH_NOTICE",
    legalBasisExplanation: optOut
      ? "Demo: person withdrew consent via preference page (test data)"
      : "Demo: explicit consent checkbox on signup form, notice v1 (test data)",
  });

  console.log(
    `✓ ${redactEmail(email)} ${optOut ? "UNSUBSCRIBED from" : "SUBSCRIBED to"} ${subscriptionId}`,
  );
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});
