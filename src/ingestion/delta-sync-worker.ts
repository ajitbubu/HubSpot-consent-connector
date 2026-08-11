/**
 * Delta sync — spec §8.2.
 * query_from = last_watermark - overlap; advance the watermark only after ALL pages
 * commit, and store the MAX OBSERVED source modification time, never job time.
 * Overlap creates duplicates by design; idempotency keys absorb them.
 */

import type { ContactsApi, HubSpotContact } from "../hubspot/contacts-api.js";
import type { CheckpointStore, PageProcessor } from "./initial-load-worker.js";

const JOB = "DELTA_SYNC";

export interface DeltaSyncResult {
  pagesProcessed: number;
  contactsProcessed: number;
  newWatermarkEpochMs: number | null;
}

export async function runDeltaSync(
  contactsApi: ContactsApi,
  checkpoints: CheckpointStore,
  processor: PageProcessor,
  options: { overlapMinutes: number; pageSize: number; initialWatermarkEpochMs: number },
): Promise<DeltaSyncResult> {
  const lastWatermark =
    (await checkpoints.readWatermark(JOB)) ?? options.initialWatermarkEpochMs;
  const queryFrom = lastWatermark - options.overlapMinutes * 60_000;

  let cursor: string | undefined;
  let pagesProcessed = 0;
  let contactsProcessed = 0;
  let maxObservedModified = lastWatermark;

  while (true) {
    const page = await contactsApi.searchModifiedSince(queryFrom, cursor, options.pageSize);

    await processor.processPage(page.contacts);
    pagesProcessed += 1;
    contactsProcessed += page.contacts.length;

    for (const contact of page.contacts) {
      const modified = sourceModifiedEpochMs(contact);
      if (modified !== null && modified > maxObservedModified) maxObservedModified = modified;
    }

    if (page.nextCursor === undefined) break;
    cursor = page.nextCursor;
  }

  // §8.2 — only after all pages committed.
  await checkpoints.writeWatermark(JOB, maxObservedModified);
  return { pagesProcessed, contactsProcessed, newWatermarkEpochMs: maxObservedModified };
}

function sourceModifiedEpochMs(contact: HubSpotContact): number | null {
  // Contacts return "lastmodifieddate"; fall back to the hs_-prefixed name.
  const raw = contact.properties["lastmodifieddate"] ?? contact.properties["hs_lastmodifieddate"];
  if (!raw) return null;
  const parsed = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}
