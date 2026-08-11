/**
 * Webhook receiver — the IMMEDIATE inbound path (spec §8.3).
 *
 * HubSpot fires an event the moment a contact changes; the receiver:
 *   1. validates the v3 signature against the RAW body (reject replays/tampering),
 *   2. deduplicates (delivery is at-least-once),
 *   3. enqueues and acks fast (never does sync work in the HTTP request),
 * and the worker then fetches the FULL contact (payloads may be partial) and
 * runs it through the inbound pipeline — which submits the change to the
 * consent platform within seconds of it happening in HubSpot.
 *
 * Framework-free: plug `handleWebhookRequest` into any HTTP server.
 */

import { validateWebhookSignatureV3, type WebhookRequest } from "../hubspot/webhook-validator.js";
import type { ContactsApi } from "../hubspot/contacts-api.js";
import type { InboundPipeline } from "./pipeline.js";

export interface HubSpotWebhookEvent {
  eventId?: number | string;
  subscriptionType: string; // e.g. contact.creation, contact.propertyChange
  portalId?: number | string;
  objectId: number | string;
  propertyName?: string;
  propertyValue?: string;
  occurredAt?: number;
  attemptNumber?: number;
}

/** Durable in production (webhook_event_seen table); in-memory for tests/demo. */
export interface WebhookDedupStore {
  isSeen(key: string): Promise<boolean>;
  markSeen(key: string): Promise<void>;
}

export interface WebhookQueue {
  enqueue(event: HubSpotWebhookEvent): Promise<void>;
}

export class InMemoryDedupStore implements WebhookDedupStore {
  private readonly seen = new Set<string>();
  async isSeen(key: string): Promise<boolean> {
    return this.seen.has(key);
  }
  async markSeen(key: string): Promise<void> {
    this.seen.add(key);
  }
}

export interface WebhookHandlerResult {
  status: number;
  body: string;
  accepted: number;
  deduplicated: number;
}

/** Dedup key: portal + event type + source event id (spec §8.3). */
export function eventDedupKey(event: HubSpotWebhookEvent): string {
  return [
    event.portalId ?? "-",
    event.subscriptionType,
    event.eventId ?? `${event.objectId}:${event.occurredAt ?? "-"}`,
  ].join("|");
}

export async function handleWebhookRequest(
  request: WebhookRequest,
  appSecret: string,
  dedup: WebhookDedupStore,
  queue: WebhookQueue,
  now: () => number = Date.now,
): Promise<WebhookHandlerResult> {
  const validation = validateWebhookSignatureV3(request, appSecret, now);
  if (!validation.valid) {
    // Never process an unauthenticated payload; 401 lets HubSpot retry if it
    // was a transient clock/config issue on our side.
    return { status: 401, body: validation.reason, accepted: 0, deduplicated: 0 };
  }

  let events: HubSpotWebhookEvent[];
  try {
    const parsed = JSON.parse(request.rawBody);
    events = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return { status: 400, body: "malformed body", accepted: 0, deduplicated: 0 };
  }

  let accepted = 0;
  let deduplicated = 0;
  for (const event of events) {
    const key = eventDedupKey(event);
    if (await dedup.isSeen(key)) {
      deduplicated += 1;
      continue;
    }
    await dedup.markSeen(key);
    await queue.enqueue(event); // fast-ack: real processing happens off-request
    accepted += 1;
  }

  return { status: 204, body: "", accepted, deduplicated };
}

/**
 * Worker side: drain queued events. The webhook payload is only a NOTIFICATION —
 * the worker always re-fetches the authoritative contact before producing
 * signals, so partial/ordered-weird payloads cannot corrupt state.
 */
export class WebhookWorker {
  constructor(
    private readonly contactsApi: ContactsApi,
    private readonly pipeline: InboundPipeline,
  ) {}

  async process(event: HubSpotWebhookEvent): Promise<"PROCESSED" | "SKIPPED"> {
    if (!event.subscriptionType.startsWith("contact.")) return "SKIPPED";
    if (
      event.subscriptionType === "contact.deletion" ||
      event.subscriptionType === "contact.privacyDeletion"
    ) {
      // Deletion handling (mapping retirement, platform notification) is a
      // platform-side policy decision — surfaced but not auto-processed here.
      return "SKIPPED";
    }

    const contact = await this.contactsApi.fetchContact(String(event.objectId));
    if (!contact) return "SKIPPED"; // deleted between event and fetch

    await this.pipeline.processContact(contact);
    return "PROCESSED";
  }
}
