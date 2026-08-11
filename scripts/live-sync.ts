/**
 * Live upstream sync — pushes HubSpot changes to the consent platform
 * IMMEDIATELY. Two detection channels run together:
 *
 *   1. Webhook receiver (instant): HTTP server on --port (default 8000).
 *      Requires HUBSPOT_APP_SECRET + a public URL registered in a HubSpot
 *      app's webhook settings; service keys alone cannot register webhooks.
 *
 *   2. Fast preference poll (near-real-time fallback, default every 5s):
 *      catches footer unsubscribes and preference-page changes that contact
 *      webhooks miss (spec §8.5).
 *
 * Shared idempotency keys ensure each real change reaches the platform once.
 *
 * Run: npx tsx scripts/live-sync.ts [--interval 5] [--port 8000]
 * Stop: Ctrl+C
 */

import { createServer } from "node:http";
import { InboundPipeline } from "../src/ingestion/pipeline.js";
import {
  InMemoryDedupStore,
  WebhookWorker,
  handleWebhookRequest,
  type HubSpotWebhookEvent,
} from "../src/ingestion/webhook-controller.js";
import { InMemoryConsentPlatform } from "../src/platform/testing/in-memory-platform.js";
import { bootstrap, portalMappings, redactEmail } from "./_shared.js";

function argValue(flag: string, fallback: number): number {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  return Number.isFinite(value) ? value : fallback;
}

async function main(): Promise<void> {
  const intervalSeconds = argValue("--interval", 5);
  const port = argValue("--port", 8000);
  const { portalId, contactsApi, preferencesApi } = bootstrap();
  const appSecret = process.env.HUBSPOT_APP_SECRET ?? null;
  const mappings = portalMappings(portalId);

  // Shared platform stub + pipeline: idempotency memory makes every channel
  // (webhook or poll) emit each real change exactly once.
  const platform = new InMemoryConsentPlatform();
  const pipeline = new InboundPipeline(preferencesApi, platform, {
    tenantId: "LIVE-TENANT",
    portalId,
    findMapping: (id) => mappings.get(id) ?? null,
  });

  let signalWatermark = 0;
  function reportNewSignals(channel: string): void {
    const fresh = platform.signals.slice(signalWatermark);
    signalWatermark = platform.signals.length;
    for (const signal of fresh) {
      console.log(
        `[${new Date().toISOString().slice(11, 19)}] ${channel} → consent DB: ` +
          `${redactEmail(signal.identity.emailNormalized)} ${signal.purposeCode ?? "(unmapped)"} = ${signal.status}`,
      );
    }
  }

  // ---- Channel 1: webhook receiver (instant) -------------------------------
  const dedup = new InMemoryDedupStore();
  const worker = new WebhookWorker(contactsApi, pipeline);
  const queue = {
    enqueue: async (event: HubSpotWebhookEvent) => {
      // Fast-ack contract: process AFTER the HTTP response, on the next tick.
      setImmediate(async () => {
        try {
          await worker.process(event);
          reportNewSignals(`webhook(${event.subscriptionType})`);
        } catch (error) {
          console.error("webhook worker error:", error instanceof Error ? error.message : error);
        }
      });
    },
  };

  if (appSecret) {
    const server = createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/webhooks/hubspot") {
        res.writeHead(404).end();
        return;
      }
      let rawBody = "";
      req.on("data", (chunk) => (rawBody += chunk));
      req.on("end", async () => {
        const result = await handleWebhookRequest(
          {
            method: "POST",
            uri: `http://localhost:${port}/webhooks/hubspot`,
            rawBody,
            signatureV3: (req.headers["x-hubspot-signature-v3"] as string) ?? null,
            timestampHeader: (req.headers["x-hubspot-request-timestamp"] as string) ?? null,
          },
          appSecret,
          dedup,
          queue,
        );
        res.writeHead(result.status).end(result.body);
      });
    });
    server.listen(port, () =>
      console.log(`Webhook receiver listening on :${port}/webhooks/hubspot (instant channel)`),
    );
  } else {
    console.log("No HUBSPOT_APP_SECRET set — webhook channel off; poll channel covers changes.");
  }

  // ---- Channel 2: fast preference poll (near-real-time fallback) -----------
  const page = await contactsApi.fetchPage(undefined, 50);
  const watched = page.contacts.filter((c) => c.properties["email"]);
  console.log(`Polling ${watched.length} contact(s) every ${intervalSeconds}s. Ctrl+C to stop.\n`);

  await pipeline.processPage(watched); // baseline
  signalWatermark = platform.signals.length;
  console.log(`Baseline captured (${signalWatermark} statuses). Watching for changes…`);

  for (;;) {
    await new Promise((r) => setTimeout(r, intervalSeconds * 1000));
    await pipeline.processPage(watched);
    reportNewSignals("poll");
  }
}

main().catch((error) => {
  console.error("✗", error instanceof Error ? error.message : error);
  process.exit(1);
});
