/**
 * SYNC WORKER TESTS
 * -----------------
 * Covers: src/ingestion/initial-load-worker.ts and delta-sync-worker.ts
 *
 * Two jobs move contacts out of HubSpot in bulk:
 *  - Initial load: pages through ALL contacts once, with a durable cursor so a
 *    crash resumes exactly where it stopped — no lost pages, no double work.
 *  - Delta sync: repeatedly fetches contacts modified since a watermark
 *    (minus an overlap window), and advances the watermark only after every
 *    page committed.
 *
 * The fakes here simulate the two failure modes that matter: a page processor
 * that throws mid-run (infrastructure failure) and pages arriving in a fixed
 * sequence so cursor arithmetic is fully predictable.
 */

import { describe, expect, it } from "vitest";
import { runInitialLoad, type CheckpointStore } from "../../src/ingestion/initial-load-worker.js";
import { runDeltaSync } from "../../src/ingestion/delta-sync-worker.js";
import type { ContactPage, ContactsApi, HubSpotContact } from "../../src/hubspot/contacts-api.js";

// Minimal contact; `modified` sets hs_lastmodifieddate for watermark tests.
function contact(id: string, modified?: string): HubSpotContact {
  return {
    id,
    properties: { email: `${id}@example.test`, ...(modified ? { hs_lastmodifieddate: modified } : {}) },
  };
}

// In-memory stand-in for the sync_checkpoint table: cursors for the initial
// load, watermarks for delta sync. Exposed maps let tests inspect durable state.
function memoryCheckpoints(): CheckpointStore & { cursors: Map<string, string | null>; watermarks: Map<string, number> } {
  const cursors = new Map<string, string | null>();
  const watermarks = new Map<string, number>();
  return {
    cursors,
    watermarks,
    readCursor: async (job) => cursors.get(job) ?? null,
    writeCursor: async (job, cursor) => {
      cursors.set(job, cursor);
    },
    readWatermark: async (job) => watermarks.get(job) ?? null,
    writeWatermark: async (job, epochMs) => {
      watermarks.set(job, epochMs);
    },
  };
}

// Fake contacts API + page processor.
//  - `pages` is the fixed sequence HubSpot "returns"; a cursor is simply the
//    index of the next page, which makes resume assertions exact.
//  - `failOnPage` makes the processor throw when it reaches that page index,
//    simulating a DB outage / crash mid-run.
function pagedApi(pages: ContactPage[], failOnPage?: number) {
  let fetches = 0;
  const api = {
    fetchPage: async (cursor: string | undefined): Promise<ContactPage> => {
      fetches++;
      const idx = cursor === undefined ? 0 : Number(cursor);
      return pages[idx]!;
    },
    searchModifiedSince: async (_since: number, cursor: string | undefined): Promise<ContactPage> => {
      fetches++;
      const idx = cursor === undefined ? 0 : Number(cursor);
      return pages[idx]!;
    },
  } as unknown as ContactsApi;

  const processed: HubSpotContact[][] = [];
  const processor = {
    processPage: async (contacts: HubSpotContact[]) => {
      if (failOnPage !== undefined && processed.length === failOnPage) {
        throw new Error("infrastructure failure");
      }
      processed.push(contacts);
    },
  };
  return { api, processor, processed, fetchCount: () => fetches };
}

describe("initial load (§7)", () => {
  // Three pages: cursors "1", "2", then no next cursor (last page).
  const pages: ContactPage[] = [
    { contacts: [contact("1"), contact("2")], nextCursor: "1" },
    { contacts: [contact("3")], nextCursor: "2" },
    { contacts: [contact("4")], nextCursor: undefined },
  ];

  // Happy path: all pages processed in order, and the durable cursor ends at
  // the DONE sentinel so the job never re-runs by accident.
  it("pages to completion and marks DONE", async () => {
    const checkpoints = memoryCheckpoints();
    const { api, processor, processed } = pagedApi(pages);

    const result = await runInitialLoad(api, checkpoints, processor, 100);

    expect(result).toMatchObject({ pagesProcessed: 3, contactsProcessed: 4, completed: true });
    expect(processed.flat().map((c) => c.id)).toEqual(["1", "2", "3", "4"]);
    expect(checkpoints.cursors.get("INITIAL_LOAD")).toBe("DONE");
  });

  // THE crash-safety test. Page index 1 fails mid-processing:
  //  - the durable cursor must still point AT the failed page (not past it),
  //  - a rerun must resume from that exact page,
  //  - contacts 3 and 4 are processed on resume; 1 and 2 are not repeated.
  // This is the "no loss or duplication after checkpoint recovery" guarantee.
  it("does not advance the cursor past an unprocessed page, and resumes from it", async () => {
    const checkpoints = memoryCheckpoints();
    const failing = pagedApi(pages, 1); // page index 1 throws

    await expect(runInitialLoad(failing.api, checkpoints, failing.processor, 100)).rejects.toThrow();
    expect(checkpoints.cursors.get("INITIAL_LOAD")).toBe("1");

    const resumed = pagedApi(pages);
    const result = await runInitialLoad(resumed.api, checkpoints, resumed.processor, 100);
    expect(result.completed).toBe(true);
    expect(resumed.processed.flat().map((c) => c.id)).toEqual(["3", "4"]);
  });

  // Once DONE, running the job again must be a harmless no-op — important
  // because schedulers may re-trigger completed jobs.
  it("is a no-op when already DONE", async () => {
    const checkpoints = memoryCheckpoints();
    checkpoints.cursors.set("INITIAL_LOAD", "DONE");
    const { api, processor } = pagedApi(pages);
    const result = await runInitialLoad(api, checkpoints, processor, 100);
    expect(result).toMatchObject({ pagesProcessed: 0, completed: true });
  });
});

describe("delta sync (§8.2)", () => {
  // The watermark must land on the LARGEST hs_lastmodifieddate actually seen in
  // the data (03:00), not the job's own clock — using job time would silently
  // skip contacts modified between fetch and commit.
  it("advances the watermark to the max observed source time, only after all pages", async () => {
    const checkpoints = memoryCheckpoints();
    checkpoints.watermarks.set("DELTA_SYNC", Date.parse("2026-08-10T00:00:00Z"));

    const { api, processor } = pagedApi([
      { contacts: [contact("1", "2026-08-10T01:00:00Z")], nextCursor: "1" },
      { contacts: [contact("2", "2026-08-10T03:00:00Z"), contact("3", "2026-08-10T02:00:00Z")], nextCursor: undefined },
    ]);

    const result = await runDeltaSync(api, checkpoints, processor, {
      overlapMinutes: 5,
      pageSize: 200,
      initialWatermarkEpochMs: 0,
    });

    expect(result.newWatermarkEpochMs).toBe(Date.parse("2026-08-10T03:00:00Z"));
    expect(checkpoints.watermarks.get("DELTA_SYNC")).toBe(Date.parse("2026-08-10T03:00:00Z"));
  });

  // Failure mid-run: if any page fails, the watermark must stay where it was so
  // the next run re-queries the whole window. (Duplicates that causes are
  // absorbed by signal idempotency — losing changes is the unrecoverable sin.)
  it("keeps the watermark untouched when a page fails mid-run", async () => {
    const checkpoints = memoryCheckpoints();
    const start = Date.parse("2026-08-10T00:00:00Z");
    checkpoints.watermarks.set("DELTA_SYNC", start);

    const failing = pagedApi(
      [
        { contacts: [contact("1", "2026-08-10T01:00:00Z")], nextCursor: "1" },
        { contacts: [contact("2", "2026-08-10T02:00:00Z")], nextCursor: undefined },
      ],
      1, // second page fails
    );

    await expect(
      runDeltaSync(failing.api, checkpoints, failing.processor, {
        overlapMinutes: 5,
        pageSize: 200,
        initialWatermarkEpochMs: 0,
      }),
    ).rejects.toThrow();
    expect(checkpoints.watermarks.get("DELTA_SYNC")).toBe(start);
  });

  // An empty delta (nothing changed in HubSpot) must not drag the watermark
  // backwards — it stays at the previous high-water mark.
  it("never moves the watermark backwards on an empty delta", async () => {
    const checkpoints = memoryCheckpoints();
    const start = Date.parse("2026-08-10T00:00:00Z");
    checkpoints.watermarks.set("DELTA_SYNC", start);

    const { api, processor } = pagedApi([{ contacts: [], nextCursor: undefined }]);
    const result = await runDeltaSync(api, checkpoints, processor, {
      overlapMinutes: 5,
      pageSize: 200,
      initialWatermarkEpochMs: 0,
    });
    expect(result.newWatermarkEpochMs).toBe(start);
  });
});
