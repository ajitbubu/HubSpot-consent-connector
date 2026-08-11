/**
 * Seeds the HubSpot portal with test contacts covering the consent states the
 * connector must distinguish. Idempotent: re-running updates the same contacts.
 *
 * Personas (all @example.com — never real people):
 *   1. ada.optin@example.com      — explicit OPT-IN to Marketing Information
 *   2. bruno.optout@example.com   — explicit OPT-OUT (unsubscribed) from Marketing Information
 *   3. cleo.silent@example.com    — contact exists, never expressed any choice
 *   4. dara.globalout@example.com — unsubscribed from EVERY subscription type
 *
 * Requires scopes: crm.objects.contacts.read/write, communication_preferences.read/write
 * Run: npm run seed
 */

import { HubSpotApiError, type HubSpotClient } from "../src/hubspot/client.js";
import { bootstrap } from "./_shared.js";

const SUBSCRIPTION_TYPES = {
  ONE_TO_ONE: "3356897875",
  MARKETING_INFORMATION: "3356897882",
} as const;

interface Persona {
  email: string;
  firstname: string;
  lastname: string;
  phone: string;
  subscribe: string[];   // subscription type IDs to opt in (with consent legal basis)
  unsubscribe: string[]; // subscription type IDs to opt out
}

const PERSONAS: Persona[] = [
  {
    email: "ada.optin@example.com",
    firstname: "Ada",
    lastname: "Optin",
    phone: "+15550100001",
    subscribe: [SUBSCRIPTION_TYPES.MARKETING_INFORMATION],
    unsubscribe: [],
  },
  {
    // v3 rejects unsubscribing someone who never subscribed, so a true opt-out
    // state requires subscribe → unsubscribe (matches a real grant-then-withdraw).
    email: "bruno.optout@example.com",
    firstname: "Bruno",
    lastname: "Optout",
    phone: "+15550100002",
    subscribe: [SUBSCRIPTION_TYPES.MARKETING_INFORMATION],
    unsubscribe: [SUBSCRIPTION_TYPES.MARKETING_INFORMATION],
  },
  {
    // Real mailbox (the portal owner's) — lets you test HubSpot's actual
    // preference page / footer-unsubscribe flow end to end.
    email: "ajitbubu@gmail.com",
    firstname: "Ajit",
    lastname: "Sahu",
    phone: "+15550100005",
    subscribe: [SUBSCRIPTION_TYPES.MARKETING_INFORMATION],
    unsubscribe: [],
  },
  {
    email: "cleo.silent@example.com",
    firstname: "Cleo",
    lastname: "Silent",
    phone: "+15550100003",
    subscribe: [],
    unsubscribe: [],
  },
  {
    email: "dara.globalout@example.com",
    firstname: "Dara",
    lastname: "Globalout",
    phone: "+15550100004",
    subscribe: [SUBSCRIPTION_TYPES.ONE_TO_ONE, SUBSCRIPTION_TYPES.MARKETING_INFORMATION],
    unsubscribe: [SUBSCRIPTION_TYPES.ONE_TO_ONE, SUBSCRIPTION_TYPES.MARKETING_INFORMATION],
  },
];

async function upsertContact(client: HubSpotClient, persona: Persona): Promise<string> {
  const properties = {
    email: persona.email,
    firstname: persona.firstname,
    lastname: persona.lastname,
    phone: persona.phone,
  };
  try {
    const created = await client.post<{ id: string }>("/crm/v3/objects/contacts", { properties });
    console.log(`   created contact ${created.id} (${persona.email})`);
    return created.id;
  } catch (error) {
    if (error instanceof HubSpotApiError && error.status === 409) {
      // Already exists — find by email and update instead.
      const search = await client.post<{ results: Array<{ id: string }> }>(
        "/crm/v3/objects/contacts/search",
        {
          filterGroups: [
            { filters: [{ propertyName: "email", operator: "EQ", value: persona.email }] },
          ],
          properties: ["email"],
          limit: 1,
        },
      );
      const existing = search.results[0];
      if (!existing) throw error;
      await client.patch(`/crm/v3/objects/contacts/${existing.id}`, { properties });
      console.log(`   updated existing contact ${existing.id} (${persona.email})`);
      return existing.id;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const { client } = bootstrap();

  console.log("→ Seeding test contacts…");
  for (const persona of PERSONAS) {
    await upsertContact(client, persona);

    for (const subscriptionId of persona.subscribe) {
      try {
        await client.post("/communication-preferences/v3/subscribe", {
          emailAddress: persona.email,
          subscriptionId,
          legalBasis: "CONSENT_WITH_NOTICE",
          legalBasisExplanation:
            "Demo: explicit consent checkbox on signup form, notice v1 (test data)",
        });
        console.log(`     ✓ subscribed to ${subscriptionId} (CONSENT_WITH_NOTICE)`);
      } catch (error) {
        if (error instanceof HubSpotApiError && error.status === 400) {
          console.log(`     - subscribe to ${subscriptionId} rejected (already set or not allowed)`);
        } else throw error;
      }
    }

    for (const subscriptionId of persona.unsubscribe) {
      try {
        // GDPR-enabled portals require a legal basis on every preference write.
        await client.post("/communication-preferences/v3/unsubscribe", {
          emailAddress: persona.email,
          subscriptionId,
          legalBasis: "CONSENT_WITH_NOTICE",
          legalBasisExplanation: "Demo: person withdrew consent via preference page (test data)",
        });
        console.log(`     ✓ unsubscribed from ${subscriptionId}`);
      } catch (error) {
        if (error instanceof HubSpotApiError && error.status === 400) {
          console.log(`     - unsubscribe from ${subscriptionId} rejected: ${error.message}`);
        } else throw error;
      }
    }
  }

  console.log("\nSeed complete. Run `npm run smoke` to pull the data through the connector.");
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});
