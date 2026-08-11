/**
 * HubSpot webhook signature validation — spec §8.3.
 * v3: HMAC-SHA256 over method + URI + raw body + timestamp, base64, keyed by the
 * app secret; timestamp must be inside the replay window. Validate against the
 * RAW request body — any re-serialization breaks the signature.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookRequest {
  method: string;
  /** Full request URI as received, e.g. https://connector.example.com/webhooks/hubspot */
  uri: string;
  rawBody: string;
  signatureV3: string | null;
  /** X-HubSpot-Request-Timestamp header value (epoch milliseconds). */
  timestampHeader: string | null;
}

export type WebhookValidation =
  | { valid: true }
  | { valid: false; reason: "MISSING_HEADERS" | "STALE_TIMESTAMP" | "BAD_SIGNATURE" };

export const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export function validateWebhookSignatureV3(
  request: WebhookRequest,
  appSecret: string,
  now: () => number = Date.now,
): WebhookValidation {
  if (!request.signatureV3 || !request.timestampHeader) {
    return { valid: false, reason: "MISSING_HEADERS" };
  }

  const timestamp = Number(request.timestampHeader);
  if (!Number.isFinite(timestamp) || Math.abs(now() - timestamp) > REPLAY_WINDOW_MS) {
    return { valid: false, reason: "STALE_TIMESTAMP" };
  }

  const payload = `${request.method}${request.uri}${request.rawBody}${request.timestampHeader}`;
  const expected = createHmac("sha256", appSecret).update(payload, "utf8").digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(request.signatureV3, "base64");
  } catch {
    return { valid: false, reason: "BAD_SIGNATURE" };
  }

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { valid: false, reason: "BAD_SIGNATURE" };
  }
  return { valid: true };
}
