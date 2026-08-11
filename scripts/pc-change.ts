/**
 * Stages 2+3 of the closed loop: Preference Center → Consent DB → Downstream (HubSpot).
 *
 * Simulates the person changing their consent in YOUR preference center:
 *   1. appends an evidenced consent event to the Consent DB (with notice
 *      version, actor, explanation — what an auditor needs),
 *   2. emits the ConsentStateChange (the outbox row),
 *   3. delivers it downstream to HubSpot via the real delivery worker
 *      (native subscription first, then loop-prevention properties),
 *   4. stores the delivery receipt back in the Consent DB.
 *
 * Run: npx tsx scripts/pc-change.ts <email> <GRANTED|WITHDRAWN> [purposeCode]
 */

import { HubSpotDeliveryWorker } from "../src/delivery/hubspot-writer.js";
import { bootstrap, findMappingByPurpose, redactEmail } from "./_shared.js";

async function main(): Promise<void> {
  const email = process.argv[2];
  const status = process.argv[3] as "GRANTED" | "WITHDRAWN" | undefined;
  const purposeCode = process.argv[4] ?? "EMAIL_MARKETING";

  const { portalId, contactsApi, preferencesApi, consentDb } = bootstrap();

  if (!email || !status || !["GRANTED", "WITHDRAWN"].includes(status)) {
    console.error("Usage: npx tsx scripts/pc-change.ts <email> <GRANTED|WITHDRAWN> [purposeCode]");
    process.exit(1);
  }

  const party = consentDb.findPartyByEmail(email);
  if (!party) {
    console.error(`No party for ${redactEmail(email)} in the Consent DB — run scripts/sync-inbound.ts first.`);
    process.exit(1);
  }

  // 1+2 — Preference-center action appended to the Consent DB, outbox row emitted.
  console.log(`→ Preference Center: ${redactEmail(email)} sets ${purposeCode} = ${status}`);
  const change = consentDb.recordPreferenceCenterChange({
    partyId: party.partyId,
    purposeCode,
    status,
    actor: "DATA_PRINCIPAL",
    noticeVersion: "demo-notice-v1",
    explanation:
      status === "WITHDRAWN"
        ? "Person withdrew consent in the preference center"
        : "Person granted consent in the preference center (affirmative action)",
  });
  console.log(`✓ Consent DB: event appended (v${change.consentVersion}, ${change.correlationId})`);

  // 3 — Downstream delivery to HubSpot through the real worker.
  const worker = new HubSpotDeliveryWorker(
    contactsApi,
    preferencesApi,
    consentDb, // PartyDestinationLookup
    consentDb, // DeliveryStore — receipts land back in the Consent DB
    (purpose) => findMappingByPurpose(portalId, purpose),
    portalId,
  );
  const receipt = await worker.deliver(change);

  console.log(
    `✓ Downstream (HubSpot): ${receipt.status}` +
      (receipt.responseCode ? ` (HTTP ${receipt.responseCode})` : "") +
      ` → contact ${receipt.destinationRecordId}, v${receipt.consentVersion}`,
  );
  if (receipt.detail) console.log(`  detail: ${receipt.detail}`);

  const state = consentDb.effectiveState(party.partyId, purposeCode);
  console.log(
    `\nEffective state in Consent DB: ${purposeCode} = ${state?.status} (v${state?.version})` +
      `\nAudit view: npx tsx scripts/build-audit-view.ts`,
  );
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});
