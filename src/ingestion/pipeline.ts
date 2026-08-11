/**
 * Inbound pipeline: HubSpot contacts → normalize → resolve party (via platform)
 * → read native subscription statuses → submit signals to the platform.
 * Used by the initial-load worker, the delta-sync worker, and the webhook worker
 * (all three feed pages of contacts through processPage).
 */

import type { HubSpotContact } from "../hubspot/contacts-api.js";
import type { PreferencesApi } from "../hubspot/preferences-api.js";
import type { MappingProfile } from "../domain/types.js";
import type { ConsentPlatformPort } from "../platform/port.js";
import type { PageProcessor } from "./initial-load-worker.js";
import { normalizeContact, signalsFromSubscriptionStatuses } from "./normalizer.js";

export interface PipelineOptions {
  tenantId: string;
  portalId: string;
  findMapping: (subscriptionTypeId: string) => MappingProfile | null;
  now?: () => Date;
}

export interface PipelineStats {
  contactsSeen: number;
  signalsSubmitted: number;
  signalsDeduplicated: number;
  signalsRejected: number;
  unresolvedParties: number;
}

export class InboundPipeline implements PageProcessor {
  readonly stats: PipelineStats = {
    contactsSeen: 0,
    signalsSubmitted: 0,
    signalsDeduplicated: 0,
    signalsRejected: 0,
    unresolvedParties: 0,
  };

  constructor(
    private readonly preferencesApi: PreferencesApi,
    private readonly platform: ConsentPlatformPort,
    private readonly options: PipelineOptions,
  ) {}

  async processPage(contacts: HubSpotContact[]): Promise<void> {
    for (const contact of contacts) {
      await this.processContact(contact);
    }
  }

  async processContact(contact: HubSpotContact): Promise<void> {
    this.stats.contactsSeen += 1;
    const now = (this.options.now ?? (() => new Date()))();

    const identity = normalizeContact(this.options.tenantId, this.options.portalId, contact);

    const resolution = await this.platform.resolveParty(identity);
    const partyId = resolution.outcome === "RESOLVED" ? resolution.partyId : null;
    if (partyId === null) this.stats.unresolvedParties += 1;

    // No usable email → no subscription statuses to read; identity alone was
    // still surfaced to the platform through resolveParty.
    if (!identity.emailNormalized) return;

    const preferences = await this.preferencesApi.fetchStatuses(identity.emailNormalized);

    const modifiedRaw =
      contact.properties["lastmodifieddate"] ?? contact.properties["hs_lastmodifieddate"];
    const effectiveAt = modifiedRaw != null ? toIso(modifiedRaw) : now.toISOString();

    const signals = signalsFromSubscriptionStatuses({
      identity,
      partyId,
      statuses: preferences.subscriptionStatuses,
      findMapping: this.options.findMapping,
      effectiveAt,
      observedAt: now.toISOString(),
    });

    for (const signal of signals) {
      const ack = await this.platform.submitSignal(signal);
      if (!ack.accepted) this.stats.signalsRejected += 1;
      else if (ack.deduplicated) this.stats.signalsDeduplicated += 1;
      else this.stats.signalsSubmitted += 1;
    }
  }
}

function toIso(raw: string): string {
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : new Date().toISOString();
}
