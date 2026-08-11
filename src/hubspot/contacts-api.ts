/**
 * HubSpot CRM Contacts API — spec §7 (initial pull) and §8.2 (delta via Search).
 * Documented endpoints only: /crm/v3/objects/contacts, /crm/v3/objects/contacts/search.
 */

import type { HubSpotClient } from "./client.js";

export interface HubSpotContact {
  id: string;
  properties: Record<string, string | null>;
}

interface ContactsPageResponse {
  results: HubSpotContact[];
  paging?: { next?: { after: string } };
}

export interface ContactPage {
  contacts: HubSpotContact[];
  /** Cursor to request the page AFTER this one; undefined on the last page. */
  nextCursor: string | undefined;
}

export const CONTACT_PROPERTIES = [
  "email",
  "firstname",
  "lastname",
  "phone",
  "hs_object_id",
  "hs_createdate",
  // Contacts expose "lastmodifieddate"; other CRM objects use "hs_lastmodifieddate".
  // Request both — the search FILTER, in contrast, accepts hs_lastmodifieddate.
  "lastmodifieddate",
  "hs_lastmodifieddate",
  "consent_party_id",
  "external_customer_id",
  "consent_sync_status",
  "consent_version",
  "consent_last_updated",
  "consent_correlation_id",
  "consent_updated_by",
] as const;

export class ContactsApi {
  constructor(private readonly client: HubSpotClient) {}

  /** One page of the initial full pull (§7). Pass the durable cursor to resume. */
  async fetchPage(cursor: string | undefined, pageSize: number): Promise<ContactPage> {
    const params = new URLSearchParams({
      limit: String(pageSize),
      properties: CONTACT_PROPERTIES.join(","),
    });
    if (cursor !== undefined) params.set("after", cursor);

    const page = await this.client.get<ContactsPageResponse>(
      `/crm/v3/objects/contacts?${params.toString()}`,
    );
    return { contacts: page.results, nextCursor: page.paging?.next?.after };
  }

  /** §9.4/§10.4 — webhook payloads may be partial; always fetch the full contact. */
  async fetchContact(contactId: string): Promise<HubSpotContact | null> {
    const params = new URLSearchParams({ properties: CONTACT_PROPERTIES.join(",") });
    try {
      return await this.client.get<HubSpotContact>(
        `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?${params.toString()}`,
      );
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  /** §8.2 — delta pull: contacts modified after the (overlap-adjusted) watermark. */
  async searchModifiedSince(
    modifiedAfterEpochMs: number,
    afterCursor: string | undefined,
    pageSize: number,
  ): Promise<ContactPage> {
    const body: Record<string, unknown> = {
      filterGroups: [
        {
          filters: [
            {
              propertyName: "hs_lastmodifieddate",
              operator: "GT",
              value: String(modifiedAfterEpochMs),
            },
          ],
        },
      ],
      sorts: ["hs_lastmodifieddate"],
      properties: [...CONTACT_PROPERTIES],
      limit: pageSize,
    };
    if (afterCursor !== undefined) body.after = afterCursor;

    const page = await this.client.post<ContactsPageResponse>(
      "/crm/v3/objects/contacts/search",
      body,
    );
    return { contacts: page.results, nextCursor: page.paging?.next?.after };
  }

  /** §9.1 — outbound CRM property update. */
  async updateProperties(contactId: string, properties: Record<string, string>): Promise<void> {
    await this.client.patch(`/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`, {
      properties,
    });
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error &&
    (error as { status: unknown }).status === 404;
}
