/**
 * Outbound delivery: your platform's ConsentStateChange commands → HubSpot.
 * Version-aware, idempotent, receipted. Writes BOTH the visibility properties
 * and the native subscription status — custom properties never enforce email
 * on their own.
 */

import { randomUUID } from "node:crypto";
import type { ContactsApi } from "../hubspot/contacts-api.js";
import type { PreferencesApi } from "../hubspot/preferences-api.js";
import { HubSpotApiError } from "../hubspot/client.js";
import type { PartyDestinationLookup } from "../platform/port.js";
import type {
  ConsentStateChange,
  DeliveryReceipt,
  DeliveryStatus,
  MappingProfile,
} from "../domain/types.js";

/** Connector-owned delivery state (see database/migrations/001_init.sql). */
export interface DeliveryStore {
  lastAppliedVersion(change: ConsentStateChange, portalId: string): Promise<number | null>;
  recordAppliedVersion(change: ConsentStateChange, portalId: string): Promise<void>;
  insertReceipt(receipt: DeliveryReceipt): Promise<void>;
}

export type VersionDecision = "APPLY" | "SKIP_EQUAL" | "STALE_VERSION_SKIPPED";

export function compareVersions(
  incomingVersion: number,
  lastAppliedVersion: number | null,
): VersionDecision {
  if (lastAppliedVersion === null || incomingVersion > lastAppliedVersion) return "APPLY";
  if (incomingVersion === lastAppliedVersion) return "SKIP_EQUAL";
  return "STALE_VERSION_SKIPPED";
}

export class HubSpotDeliveryWorker {
  constructor(
    private readonly contactsApi: ContactsApi,
    private readonly preferencesApi: PreferencesApi,
    private readonly destinations: PartyDestinationLookup,
    private readonly store: DeliveryStore,
    private readonly findMapping: (purposeCode: string) => MappingProfile | null,
    private readonly portalId: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async deliver(change: ConsentStateChange): Promise<DeliveryReceipt> {
    const destination = await this.destinations.findHubSpotContact(
      change.tenantId,
      change.partyId,
      this.portalId,
    );
    if (!destination) {
      // Provisioning is off by default: the connector never creates contacts.
      return this.receipt(change, "-", "CONTACT_NOT_FOUND");
    }

    const lastApplied = await this.store.lastAppliedVersion(change, this.portalId);
    const decision = compareVersions(change.consentVersion, lastApplied);
    if (decision === "SKIP_EQUAL") {
      return this.receipt(change, destination.contactId, "DELIVERED");
    }
    if (decision === "STALE_VERSION_SKIPPED") {
      return this.receipt(change, destination.contactId, "STALE_VERSION_SKIPPED");
    }

    const mapping = this.findMapping(change.purposeCode);
    if (!mapping || mapping.direction === "INBOUND") {
      // No approved writeback mapping for this purpose.
      return this.receipt(change, destination.contactId, "NOT_SUPPORTED");
    }

    try {
      // Native subscription state first: it is the enforcement surface.
      if (change.effectiveStatus === "WITHDRAWN" || change.effectiveStatus === "SUPPRESSED") {
        if (destination.email) {
          await this.preferencesApi.unsubscribe(destination.email, mapping.subscriptionTypeId);
        }
      } else if (change.effectiveStatus === "GRANTED") {
        // Your platform only emits GRANTED after its own evidence validation.
        // The v3 API cannot resubscribe a previously opted-out contact; that
        // rejection maps to NOT_SUPPORTED via classifyDeliveryError.
        if (destination.email) {
          await this.preferencesApi.subscribe(
            destination.email,
            mapping.subscriptionTypeId,
            "LEGITIMATE_INTEREST_CLIENT",
            `Platform consent version ${change.consentVersion}`,
          );
        }
      }

      // Visibility properties, including the loop-prevention markers.
      await this.contactsApi.updateProperties(destination.contactId, {
        consent_party_id: change.partyId,
        consent_sync_status: "SYNCED",
        consent_version: String(change.consentVersion),
        consent_last_updated: change.effectiveAt,
        consent_source: "CONSENT_PLATFORM",
        consent_correlation_id: change.correlationId,
        consent_updated_by: "CONSENT_PLATFORM",
      });

      await this.store.recordAppliedVersion(change, this.portalId);
      return this.receipt(change, destination.contactId, "DELIVERED", 200);
    } catch (error) {
      const classified = classifyDeliveryError(error);
      return this.receipt(
        change,
        destination.contactId,
        classified.status,
        classified.responseCode,
        classified.detail,
      );
    }
  }

  private async receipt(
    change: ConsentStateChange,
    contactId: string,
    status: DeliveryStatus,
    responseCode?: number,
    detail?: string,
  ): Promise<DeliveryReceipt> {
    const receipt: DeliveryReceipt = {
      deliveryId: `DEL-${randomUUID()}`,
      changeId: change.changeId,
      destinationSystem: "HUBSPOT",
      destinationTenantId: this.portalId,
      destinationRecordId: contactId,
      consentVersion: change.consentVersion,
      status,
      attemptCount: 1,
      ...(status === "DELIVERED" ? { deliveredAt: this.now().toISOString() } : {}),
      ...(responseCode !== undefined ? { responseCode } : {}),
      ...(detail !== undefined ? { detail } : {}),
    };
    await this.store.insertReceipt(receipt);
    return receipt;
  }
}

/** Retry classification for delivery failures. */
export function classifyDeliveryError(error: unknown): {
  status: DeliveryStatus;
  responseCode?: number;
  detail?: string;
} {
  if (error instanceof HubSpotApiError) {
    if (error.status === 404) return { status: "CONTACT_NOT_FOUND", responseCode: 404 };
    if (error.retryable) {
      return { status: "RETRYABLE_FAILURE", responseCode: error.status, detail: "retry with backoff" };
    }
    // 400 on a subscribe call includes the v3 cannot-resubscribe rejection.
    if (error.status === 400) {
      return { status: "NOT_SUPPORTED", responseCode: 400, detail: "rejected by preference API" };
    }
    return { status: "PERMANENT_FAILURE", responseCode: error.status };
  }
  return { status: "RETRYABLE_FAILURE", detail: "transient transport failure" };
}

/**
 * Loop prevention — inbound side. Skip a property-change event ONLY when all
 * three conditions hold; never blanket-ignore the integration user.
 */
export function isConnectorEcho(input: {
  inboundCorrelationId: string | null;
  inboundVersion: string | null;
  changedProperties: string[];
  completedCorrelationId: string | null;
  deliveredVersion: number | null;
  connectorWrittenProperties: string[];
}): boolean {
  if (!input.inboundCorrelationId || !input.completedCorrelationId) return false;
  if (input.inboundCorrelationId !== input.completedCorrelationId) return false;
  if (input.inboundVersion === null || input.deliveredVersion === null) return false;
  if (Number(input.inboundVersion) !== input.deliveredVersion) return false;
  const written = new Set(input.connectorWrittenProperties);
  return input.changedProperties.every((property) => written.has(property));
}
