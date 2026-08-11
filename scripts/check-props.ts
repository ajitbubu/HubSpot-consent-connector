/**
 * Read the connector's custom properties for one contact (loop-prevention
 * markers written by outbound delivery).
 * Usage: npx tsx scripts/check-props.ts <email>
 */

import { bootstrap, redactEmail } from "./_shared.js";

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email) {
    console.error("Usage: npx tsx scripts/check-props.ts <email>");
    process.exit(1);
  }
  const { client } = bootstrap();
  const search = await client.post<{
    results: Array<{ id: string; properties: Record<string, string | null> }>;
  }>("/crm/v3/objects/contacts/search", {
    filterGroups: [{ filters: [{ propertyName: "email", operator: "EQ", value: email }] }],
    properties: [
      "consent_party_id",
      "consent_sync_status",
      "consent_version",
      "consent_last_updated",
      "consent_source",
      "consent_correlation_id",
      "consent_updated_by",
    ],
    limit: 1,
  });
  const contact = search.results[0];
  if (!contact) {
    console.log("Contact not found");
    return;
  }
  console.log(`${redactEmail(email)} (contact ${contact.id}) connector properties:`);
  for (const [key, value] of Object.entries(contact.properties)) {
    if (key.startsWith("consent_") && value) console.log(`  ${key} = ${value}`);
  }
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});
