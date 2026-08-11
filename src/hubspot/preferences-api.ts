/**
 * HubSpot Communication Preferences API — spec §8.1 and §9.2.
 * The read endpoint is keyed by EMAIL, not contact ID (verified against the v3 docs).
 * v3 cannot resubscribe a previously opted-out contact — the writer must surface
 * NOT_SUPPORTED for that case (§9.2), never attempt a workaround.
 */

import type { HubSpotClient } from "./client.js";

export interface SubscriptionStatus {
  id: string; // subscription type ID — authoritative (names are display metadata, §5.1)
  name: string;
  /**
   * Verified against the live v3 API: real portals return NOT_SUBSCRIBED (which
   * covers both "opted out" and "never chose"). UNSUBSCRIBED/NOT_SPECIFIED are
   * kept for portals/tiers that emit the documented legacy vocabulary.
   */
  status: "SUBSCRIBED" | "UNSUBSCRIBED" | "NOT_SUBSCRIBED" | "NOT_SPECIFIED";
  sourceOfStatus?: string;
  brandId?: string | null;
  legalBasis?: string | null;
  legalBasisExplanation?: string | null;
}

export interface PreferenceStatusResponse {
  recipient: string;
  subscriptionStatuses: SubscriptionStatus[];
}

export class PreferencesApi {
  constructor(private readonly client: HubSpotClient) {}

  /** §8.1 — read current subscription statuses for an email address. */
  async fetchStatuses(email: string): Promise<PreferenceStatusResponse> {
    return this.client.get<PreferenceStatusResponse>(
      `/communication-preferences/v3/status/email/${encodeURIComponent(email)}`,
    );
  }

  /**
   * §9.2 — unsubscribe the email from one subscription type.
   * GDPR-enabled portals require a legal basis on EVERY preference write,
   * including unsubscribes (verified against a live portal).
   */
  async unsubscribe(
    email: string,
    subscriptionTypeId: string,
    legalBasis = "CONSENT_WITH_NOTICE",
    legalBasisExplanation = "Consent platform: person withdrew this preference",
  ): Promise<void> {
    await this.client.post("/communication-preferences/v3/unsubscribe", {
      emailAddress: email,
      subscriptionId: subscriptionTypeId,
      legalBasis,
      legalBasisExplanation,
    });
  }

  /**
   * §9.2 — subscribe. Only callable when a current Platform grant with complete
   * evidence exists AND the mapping authorizes writeback. v3 rejects resubscription
   * of a previously opted-out contact; callers must map that rejection to NOT_SUPPORTED.
   */
  async subscribe(
    email: string,
    subscriptionTypeId: string,
    legalBasis: string,
    legalBasisExplanation: string,
  ): Promise<void> {
    await this.client.post("/communication-preferences/v3/subscribe", {
      emailAddress: email,
      subscriptionId: subscriptionTypeId,
      legalBasis,
      legalBasisExplanation,
    });
  }
}
