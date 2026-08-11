/**
 * Creates the connector's custom contact properties in the portal (idempotent).
 * These carry sync status + loop-prevention markers on outbound writes.
 * Demo note: all text/number for simplicity; production may prefer enumerations
 * and datetime types per the spec (§5.2).
 *
 * Run: npx tsx scripts/ensure-properties.ts
 */

import { HubSpotApiError } from "../src/hubspot/client.js";
import { bootstrap } from "./_shared.js";

const GROUP = { name: "consent_connector", label: "Consent Connector", displayOrder: -1 };

const PROPERTIES = [
  { name: "consent_party_id", label: "Consent Party ID", type: "string", fieldType: "text" },
  { name: "consent_sync_status", label: "Consent Sync Status", type: "string", fieldType: "text" },
  { name: "consent_version", label: "Consent Version", type: "number", fieldType: "number" },
  { name: "consent_last_updated", label: "Consent Last Updated", type: "string", fieldType: "text" },
  { name: "consent_source", label: "Consent Source", type: "string", fieldType: "text" },
  { name: "consent_correlation_id", label: "Consent Correlation ID", type: "string", fieldType: "text" },
  { name: "consent_updated_by", label: "Consent Updated By", type: "string", fieldType: "text" },
];

async function main(): Promise<void> {
  const { client } = bootstrap();

  try {
    await client.post("/crm/v3/properties/contacts/groups", GROUP);
    console.log(`✓ created property group "${GROUP.name}"`);
  } catch (error) {
    if (error instanceof HubSpotApiError && error.status === 409) {
      console.log(`- property group "${GROUP.name}" already exists`);
    } else throw error;
  }

  for (const property of PROPERTIES) {
    try {
      await client.post("/crm/v3/properties/contacts", { ...property, groupName: GROUP.name });
      console.log(`✓ created property ${property.name}`);
    } catch (error) {
      if (error instanceof HubSpotApiError && error.status === 409) {
        console.log(`- property ${property.name} already exists`);
      } else throw error;
    }
  }

  console.log("\nProperties ready.");
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});
