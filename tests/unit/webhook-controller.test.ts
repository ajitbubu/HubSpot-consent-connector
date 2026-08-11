/**
 * WEBHOOK RECEIVER TESTS
 * ----------------------
 * Covers: src/ingestion/webhook-controller.ts — the immediate inbound path.
 * Verifies the receiver contract: authenticated events are enqueued and acked
 * fast; duplicates are dropped; unauthenticated payloads never reach the queue.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InMemoryDedupStore,
  eventDedupKey,
  handleWebhookRequest,
  type HubSpotWebhookEvent,
} from "../../src/ingestion/webhook-controller.js";
import type { WebhookRequest } from "../../src/hubspot/webhook-validator.js";

const SECRET = "test-app-secret";
const URI = "https://connector.example.com/webhooks/hubspot";

function signed(events: HubSpotWebhookEvent[], timestamp: number): WebhookRequest {
  const rawBody = JSON.stringify(events);
  const signature = createHmac("sha256", SECRET)
    .update(`POST${URI}${rawBody}${timestamp}`, "utf8")
    .digest("base64");
  return { method: "POST", uri: URI, rawBody, signatureV3: signature, timestampHeader: String(timestamp) };
}

function collector() {
  const enqueued: HubSpotWebhookEvent[] = [];
  return { enqueued, enqueue: async (e: HubSpotWebhookEvent) => void enqueued.push(e) };
}

const EVENT: HubSpotWebhookEvent = {
  eventId: 789,
  subscriptionType: "contact.propertyChange",
  portalId: 247009488,
  objectId: 533523553004,
  propertyName: "hs_email_optout",
  occurredAt: 1786400000000,
};

describe("webhook receiver (immediate inbound)", () => {
  const now = () => Date.parse("2026-08-10T12:00:00Z");

  it("accepts a signed event batch: enqueues each event and acks 204", async () => {
    const queue = collector();
    const result = await handleWebhookRequest(
      signed([EVENT, { ...EVENT, eventId: 790 }], now()),
      SECRET,
      new InMemoryDedupStore(),
      queue,
      now,
    );
    expect(result).toMatchObject({ status: 204, accepted: 2, deduplicated: 0 });
    expect(queue.enqueued).toHaveLength(2);
  });

  it("drops duplicate deliveries (at-least-once) without re-enqueueing", async () => {
    const queue = collector();
    const dedup = new InMemoryDedupStore();
    await handleWebhookRequest(signed([EVENT], now()), SECRET, dedup, queue, now);
    const second = await handleWebhookRequest(signed([EVENT], now()), SECRET, dedup, queue, now);
    expect(second).toMatchObject({ status: 204, accepted: 0, deduplicated: 1 });
    expect(queue.enqueued).toHaveLength(1);
  });

  it("rejects a bad signature and enqueues nothing", async () => {
    const queue = collector();
    const request = { ...signed([EVENT], now()), signatureV3: "not-a-real-signature" };
    const result = await handleWebhookRequest(request, SECRET, new InMemoryDedupStore(), queue, now);
    expect(result.status).toBe(401);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("rejects malformed JSON after a valid signature", async () => {
    const queue = collector();
    const timestamp = now();
    const rawBody = "not-json";
    const signature = createHmac("sha256", SECRET)
      .update(`POST${URI}${rawBody}${timestamp}`, "utf8")
      .digest("base64");
    const result = await handleWebhookRequest(
      { method: "POST", uri: URI, rawBody, signatureV3: signature, timestampHeader: String(timestamp) },
      SECRET,
      new InMemoryDedupStore(),
      queue,
      now,
    );
    expect(result.status).toBe(400);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("derives a stable dedup key from portal + type + event id", () => {
    expect(eventDedupKey(EVENT)).toBe("247009488|contact.propertyChange|789");
    // Falls back to objectId+occurredAt when no event id exists.
    const { eventId, ...withoutEventId } = EVENT;
    expect(eventDedupKey(withoutEventId)).toBe(
      "247009488|contact.propertyChange|533523553004:1786400000000",
    );
  });
});
