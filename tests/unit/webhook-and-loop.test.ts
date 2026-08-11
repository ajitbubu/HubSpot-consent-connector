/**
 * WEBHOOK SECURITY + LOOP PREVENTION TESTS
 * ----------------------------------------
 * Covers: src/hubspot/webhook-validator.ts and isConnectorEcho() from
 *         src/delivery/hubspot-writer.ts
 *
 * Part 1 — webhook signatures: HubSpot signs each webhook with HMAC-SHA256 over
 * method + URI + raw body + timestamp, using the app secret as the key
 * (X-HubSpot-Signature-v3). The validator must accept only a correctly signed,
 * fresh request; everything else (replayed, tampered, wrong key, headerless)
 * is rejected before any processing happens.
 *
 * Part 2 — loop prevention: the connector writes to HubSpot, and HubSpot then
 * fires a propertyChange webhook about that very write. Without a guard the two
 * systems would echo forever. An inbound event may be skipped ONLY when it is
 * provably our own write: same correlation ID AND same version AND only fields
 * we wrote. Anything less specific must be processed normally.
 */

import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  validateWebhookSignatureV3,
  type WebhookRequest,
} from "../../src/hubspot/webhook-validator.js";
import { isConnectorEcho } from "../../src/delivery/hubspot-writer.js";

const SECRET = "test-app-secret";
const URI = "https://connector.example.com/webhooks/hubspot";

// Builds a request signed exactly the way HubSpot signs it, so the validator's
// own math is exercised. Tests then break one ingredient at a time.
function signedRequest(body: string, timestamp: number, secret = SECRET): WebhookRequest {
  const signature = createHmac("sha256", secret)
    .update(`POST${URI}${body}${timestamp}`, "utf8")
    .digest("base64");
  return {
    method: "POST",
    uri: URI,
    rawBody: body,
    signatureV3: signature,
    timestampHeader: String(timestamp),
  };
}

describe("webhook signature v3 (§8.3)", () => {
  // Fixed clock so "fresh" and "stale" are deterministic.
  const now = () => Date.parse("2026-08-10T12:00:00Z");

  // Baseline: correct secret, fresh timestamp, untouched body → valid.
  it("accepts a valid signature inside the replay window", () => {
    const request = signedRequest('[{"eventId":1}]', now() - 1000);
    expect(validateWebhookSignatureV3(request, SECRET, now)).toEqual({ valid: true });
  });

  // Replay protection: the signature itself is correct, but it was minted six
  // minutes ago (window is five). An attacker replaying a captured request must
  // be refused even though the HMAC checks out.
  it("rejects a stale timestamp (replay protection)", () => {
    const request = signedRequest("[]", now() - 6 * 60 * 1000);
    expect(validateWebhookSignatureV3(request, SECRET, now)).toMatchObject({
      valid: false,
      reason: "STALE_TIMESTAMP",
    });
  });

  // Tamper detection: body changed after signing → HMAC no longer matches.
  // This is also why the validator must see the RAW body, not a re-parse.
  it("rejects a tampered body", () => {
    const request = { ...signedRequest("[]", now()), rawBody: '[{"evil":true}]' };
    expect(validateWebhookSignatureV3(request, SECRET, now)).toMatchObject({
      valid: false,
      reason: "BAD_SIGNATURE",
    });
  });

  // A signature produced with a different app secret must fail — this is what
  // stops arbitrary third parties from posting fake webhook events.
  it("rejects a signature from the wrong secret", () => {
    const request = signedRequest("[]", now(), "other-secret");
    expect(validateWebhookSignatureV3(request, SECRET, now)).toMatchObject({
      valid: false,
      reason: "BAD_SIGNATURE",
    });
  });

  // No signature header at all → reject immediately, before any crypto.
  it("rejects missing headers", () => {
    const request = { ...signedRequest("[]", now()), signatureV3: null };
    expect(validateWebhookSignatureV3(request, SECRET, now)).toMatchObject({
      valid: false,
      reason: "MISSING_HEADERS",
    });
  });
});

describe("loop prevention (§9.4)", () => {
  // "base" describes a TRUE echo: the inbound webhook carries the exact
  // correlation ID we stamped (CORR-123), the exact version we delivered (17),
  // and every changed property is one the connector itself wrote.
  const base = {
    inboundCorrelationId: "CORR-123",
    inboundVersion: "17",
    changedProperties: ["consent_sync_status", "consent_version", "consent_correlation_id"],
    completedCorrelationId: "CORR-123",
    deliveredVersion: 17,
    connectorWrittenProperties: [
      "consent_party_id",
      "consent_sync_status",
      "consent_version",
      "consent_last_updated",
      "consent_source",
      "consent_correlation_id",
      "consent_updated_by",
    ],
  };

  // All three conditions hold → safe to skip; processing it would start a loop.
  it("skips a true echo: matching correlation, version, and fields", () => {
    expect(isConnectorEcho(base)).toBe(true);
  });

  // Different correlation ID → this is some OTHER write, not our echo. Process it.
  it("does not skip when the correlation ID differs", () => {
    expect(isConnectorEcho({ ...base, inboundCorrelationId: "CORR-999" })).toBe(false);
  });

  // Same correlation but a different version → state moved on; must process.
  it("does not skip when the version differs", () => {
    expect(isConnectorEcho({ ...base, inboundVersion: "18" })).toBe(false);
  });

  // The subtle one: a human (or workflow) edited the contact's email in the
  // same change batch. "email" is not a property the connector writes, so this
  // event carries real new information — skipping it would silently drop a
  // material change. This is why the connector never blanket-ignores events
  // from its own integration user.
  it("does not skip when a human changed additional fields under the integration user", () => {
    expect(
      isConnectorEcho({ ...base, changedProperties: [...base.changedProperties, "email"] }),
    ).toBe(false);
  });

  // No completed outbound delivery to compare against → nothing to prove the
  // event is ours; process it.
  it("does not skip when there is no completed outbound correlation", () => {
    expect(isConnectorEcho({ ...base, completedCorrelationId: null })).toBe(false);
  });
});
