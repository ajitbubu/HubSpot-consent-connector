/**
 * File-backed consent DB — a persistent demo implementation of the platform
 * side (your real consent platform replaces this; same port, same shapes).
 *
 * Holds, in .consent-db.json:
 *   - parties:   who each HubSpot contact resolved to
 *   - events:    APPEND-ONLY consent record log (inbound signals + preference-
 *                center actions), each with provenance and evidence hashes
 *   - receipts:  downstream delivery results (the audit trail of enforcement)
 *   - appliedVersions: per-destination version tracking for the delivery gate
 *
 * The audit view (scripts/build-audit-view.ts) renders this file for the
 * person and the auditor: current state per purpose + full evidence log.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type {
  ConsentSignal,
  ConsentStateChange,
  DeliveryReceipt,
  NormalizedIdentityRecord,
} from "../../domain/types.js";
import type {
  ConsentPlatformPort,
  PartyDestinationLookup,
  PartyResolution,
  SignalAck,
} from "../port.js";
import type { DeliveryStore } from "../../delivery/hubspot-writer.js";

export type EffectiveStatus = "GRANTED" | "WITHDRAWN" | "UNKNOWN";

export interface ConsentDbEvent {
  eventId: string;
  partyId: string;
  purposeCode: string | null;
  channel: "EMAIL";
  /** Raw source status (inbound) or the commanded status (preference center). */
  status: string;
  /** Platform interpretation, per demo policy (§ notes in README). */
  derivedStatus: EffectiveStatus;
  origin: "HUBSPOT" | "PREFERENCE_CENTER";
  consentVersion: number;
  effectiveAt: string;
  recordedAt: string;
  evidence: {
    method: string;
    payloadHash?: string;
    sourceRef?: string;
    idempotencyKey?: string;
    actor?: string;
    noticeVersion?: string;
    explanation?: string;
  };
}

export interface ConsentDbParty {
  partyId: string;
  emailNormalized: string | null;
  firstName: string | null;
  lastName: string | null;
  portalId: string;
  contactId: string;
  tenantId: string;
}

interface DbShape {
  parties: Record<string, ConsentDbParty>;
  events: ConsentDbEvent[];
  receipts: DeliveryReceipt[];
  appliedVersions: Record<string, number>;
  seenSignalKeys: string[];
}

const EMPTY: DbShape = { parties: {}, events: [], receipts: [], appliedVersions: {}, seenSignalKeys: [] };

export class FileConsentDb implements ConsentPlatformPort, PartyDestinationLookup, DeliveryStore {
  private db: DbShape;

  constructor(private readonly filePath: URL) {
    try {
      this.db = { ...EMPTY, ...(JSON.parse(readFileSync(filePath, "utf8")) as DbShape) };
    } catch {
      this.db = structuredClone(EMPTY);
    }
  }

  private save(): void {
    writeFileSync(this.filePath, JSON.stringify(this.db, null, 2));
  }

  // ---- ConsentPlatformPort (inbound) ---------------------------------------

  async resolveParty(record: NormalizedIdentityRecord): Promise<PartyResolution> {
    const key = `${record.portalId}|${record.contactId}`;
    let party = Object.values(this.db.parties).find(
      (p) => `${p.portalId}|${p.contactId}` === key,
    );
    if (!party) {
      party = {
        partyId: `PARTY-${Object.keys(this.db.parties).length + 1}`,
        emailNormalized: record.emailNormalized,
        firstName: record.firstName,
        lastName: record.lastName,
        portalId: record.portalId,
        contactId: record.contactId,
        tenantId: record.tenantId,
      };
      this.db.parties[party.partyId] = party;
      this.save();
    }
    return { outcome: "RESOLVED", partyId: party.partyId };
  }

  async submitSignal(signal: ConsentSignal): Promise<SignalAck> {
    if (this.db.seenSignalKeys.includes(signal.idempotencyKey)) {
      return { accepted: true, deduplicated: true };
    }
    this.db.seenSignalKeys.push(signal.idempotencyKey);

    // Demo interpretation policy: SUBSCRIBED → GRANTED; UNSUBSCRIBED → WITHDRAWN;
    // NOT_SUBSCRIBED is AMBIGUOUS (opted out or never chose) → UNKNOWN, pending
    // corroboration. Your platform's validation service replaces this.
    const derivedStatus: EffectiveStatus =
      signal.status === "SUBSCRIBED"
        ? "GRANTED"
        : signal.status === "UNSUBSCRIBED"
          ? "WITHDRAWN"
          : "UNKNOWN";

    this.appendEvent({
      partyId: signal.partyId ?? "UNRESOLVED",
      purposeCode: signal.purposeCode,
      channel: signal.channel,
      status: signal.status,
      derivedStatus,
      origin: "HUBSPOT",
      effectiveAt: signal.effectiveAt,
      evidence: {
        method: "HUBSPOT_SUBSCRIPTION_STATUS",
        payloadHash: signal.payloadHash,
        sourceRef: `hubspot:${signal.source.portalId}:${signal.source.objectId}:${signal.source.subscriptionTypeId ?? "-"}`,
        idempotencyKey: signal.idempotencyKey,
      },
    });
    return { accepted: true, deduplicated: false };
  }

  // ---- Preference-center actions (the person changes their consent) --------

  recordPreferenceCenterChange(input: {
    partyId: string;
    purposeCode: string;
    status: "GRANTED" | "WITHDRAWN";
    actor: string;
    noticeVersion: string;
    explanation: string;
  }): ConsentStateChange {
    const party = this.db.parties[input.partyId];
    if (!party) throw new Error(`Unknown party ${input.partyId}`);

    const event = this.appendEvent({
      partyId: input.partyId,
      purposeCode: input.purposeCode,
      channel: "EMAIL",
      status: input.status,
      derivedStatus: input.status,
      origin: "PREFERENCE_CENTER",
      effectiveAt: new Date().toISOString(),
      evidence: {
        method: "PREFERENCE_CENTER_ACTION",
        actor: input.actor,
        noticeVersion: input.noticeVersion,
        explanation: input.explanation,
      },
    });

    // The outbox row your platform would emit in the same transaction.
    return {
      changeId: `CHG-${event.eventId}`,
      tenantId: party.tenantId,
      partyId: input.partyId,
      purposeCode: input.purposeCode,
      channel: "EMAIL",
      effectiveStatus: input.status,
      effectiveAt: event.effectiveAt,
      consentVersion: event.consentVersion,
      originSystem: "PREFERENCE_CENTER",
      correlationId: `CORR-${event.eventId.slice(0, 8)}`,
    };
  }

  private appendEvent(
    input: Omit<ConsentDbEvent, "eventId" | "consentVersion" | "recordedAt">,
  ): ConsentDbEvent {
    const consentVersion =
      this.db.events.filter((e) => e.partyId === input.partyId).length + 1;
    const event: ConsentDbEvent = {
      ...input,
      eventId: randomUUID(),
      consentVersion,
      recordedAt: new Date().toISOString(),
    };
    this.db.events.push(event);
    this.save();
    return event;
  }

  // ---- Effective state (derived, never edited) -----------------------------

  effectiveState(partyId: string, purposeCode: string): { status: EffectiveStatus; version: number; at: string } | null {
    let current: { status: EffectiveStatus; version: number; at: string } | null = null;
    for (const event of this.db.events) {
      if (event.partyId !== partyId || event.purposeCode !== purposeCode) continue;
      // UNKNOWN never overwrites a known state; known states apply in order.
      if (event.derivedStatus === "UNKNOWN" && current !== null) continue;
      current = { status: event.derivedStatus, version: event.consentVersion, at: event.effectiveAt };
    }
    return current;
  }

  // ---- PartyDestinationLookup + DeliveryStore (outbound) -------------------

  async findHubSpotContact(
    _tenantId: string,
    partyId: string,
    portalId: string,
  ): Promise<{ contactId: string; email: string | null } | null> {
    const party = this.db.parties[partyId];
    if (!party || party.portalId !== portalId) return null;
    return { contactId: party.contactId, email: party.emailNormalized };
  }

  async lastAppliedVersion(change: ConsentStateChange, portalId: string): Promise<number | null> {
    return this.db.appliedVersions[versionKey(change, portalId)] ?? null;
  }

  async recordAppliedVersion(change: ConsentStateChange, portalId: string): Promise<void> {
    this.db.appliedVersions[versionKey(change, portalId)] = change.consentVersion;
    this.save();
  }

  async insertReceipt(receipt: DeliveryReceipt): Promise<void> {
    this.db.receipts.push(receipt);
    this.save();
  }

  // ---- Read access for the audit view --------------------------------------

  snapshot(): Readonly<DbShape> {
    return this.db;
  }

  findPartyByEmail(email: string): ConsentDbParty | null {
    const normalized = email.trim().toLowerCase();
    return Object.values(this.db.parties).find((p) => p.emailNormalized === normalized) ?? null;
  }
}

function versionKey(change: ConsentStateChange, portalId: string): string {
  return [change.tenantId, portalId, change.partyId, change.purposeCode, change.channel].join("|");
}
