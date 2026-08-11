/** Shared bootstrap for the demo scripts. */

import { readFileSync } from "node:fs";
import { PrivateAppTokenProvider } from "../src/auth/token-service.js";
import { HubSpotClient, type FetchLike } from "../src/hubspot/client.js";
import { ContactsApi } from "../src/hubspot/contacts-api.js";
import { PreferencesApi } from "../src/hubspot/preferences-api.js";
import { FileConsentDb } from "../src/platform/testing/file-consent-db.js";
import type { MappingProfile } from "../src/domain/types.js";

export const CONSENT_DB_FILE = new URL("../.consent-db.json", import.meta.url);

export function loadDotEnv(): void {
  try {
    for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (match && !(match[1]! in process.env)) process.env[match[1]!] = match[2]!;
    }
  } catch {
    /* fall through */
  }
}

export function redactEmail(email: string | null | undefined): string {
  if (!email) return "(none)";
  const [local, domain] = email.split("@");
  return `${(local ?? "").slice(0, 2)}***@${domain ?? "?"}`;
}

export function bootstrap() {
  loadDotEnv();
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) {
    console.error("Missing HUBSPOT_PRIVATE_APP_TOKEN in .env");
    process.exit(1);
  }
  const portalId = process.env.HUBSPOT_PORTAL_ID ?? "unknown-portal";
  const fetchLike: FetchLike = (url, init) => fetch(url, init);
  const client = new HubSpotClient(fetchLike, new PrivateAppTokenProvider(async () => token));
  return {
    portalId,
    client,
    contactsApi: new ContactsApi(client),
    preferencesApi: new PreferencesApi(client),
    consentDb: new FileConsentDb(CONSENT_DB_FILE),
  };
}

export function portalMappings(portalId: string): Map<string, MappingProfile> {
  return new Map(
    [
      { subscriptionTypeId: "3356897882", purposeCode: "EMAIL_MARKETING" },
      { subscriptionTypeId: "3356897875", purposeCode: "ONE_TO_ONE_EMAIL" },
    ].map((m) => [
      m.subscriptionTypeId,
      {
        mappingProfileId: `hubspot-map-${portalId}`,
        version: "1.0.0",
        portalId,
        businessUnitId: "0",
        subscriptionTypeId: m.subscriptionTypeId,
        purposeCode: m.purposeCode,
        channel: "EMAIL" as const,
        direction: "BIDIRECTIONAL" as const,
      },
    ]),
  );
}

export function findMappingByPurpose(portalId: string, purposeCode: string): MappingProfile | null {
  for (const mapping of portalMappings(portalId).values()) {
    if (mapping.purposeCode === purposeCode) return mapping;
  }
  return null;
}
