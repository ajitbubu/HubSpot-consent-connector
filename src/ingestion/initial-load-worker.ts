/**
 * Initial full pull — spec §7.
 * Checkpointed cursor pagination: the durable cursor advances only after the page
 * is fully processed (every item accepted, deduplicated, or durably quarantined).
 */

import type { ContactsApi, HubSpotContact } from "../hubspot/contacts-api.js";

export interface CheckpointStore {
  readCursor(jobType: string): Promise<string | null>;
  /** Persist progress; "DONE" sentinel marks completion. */
  writeCursor(jobType: string, cursor: string | null): Promise<void>;
  readWatermark(jobType: string): Promise<number | null>;
  writeWatermark(jobType: string, epochMs: number): Promise<void>;
}

export interface PageProcessor {
  /**
   * Process one page transactionally. Must not throw for per-record policy
   * outcomes (those quarantine); throws only on infrastructure failure, which
   * leaves the checkpoint untouched for safe resume.
   */
  processPage(contacts: HubSpotContact[]): Promise<void>;
}

const JOB = "INITIAL_LOAD";
const DONE = "DONE";

export interface InitialLoadResult {
  pagesProcessed: number;
  contactsProcessed: number;
  completed: boolean;
}

export async function runInitialLoad(
  contactsApi: ContactsApi,
  checkpoints: CheckpointStore,
  processor: PageProcessor,
  pageSize: number,
): Promise<InitialLoadResult> {
  let cursor = await checkpoints.readCursor(JOB);
  if (cursor === DONE) return { pagesProcessed: 0, contactsProcessed: 0, completed: true };

  let pagesProcessed = 0;
  let contactsProcessed = 0;

  while (true) {
    const page = await contactsApi.fetchPage(cursor ?? undefined, pageSize);

    // Process BEFORE advancing the durable cursor (§7.3).
    await processor.processPage(page.contacts);
    pagesProcessed += 1;
    contactsProcessed += page.contacts.length;

    if (page.nextCursor === undefined) {
      await checkpoints.writeCursor(JOB, DONE);
      return { pagesProcessed, contactsProcessed, completed: true };
    }
    cursor = page.nextCursor;
    await checkpoints.writeCursor(JOB, cursor);
  }
}
