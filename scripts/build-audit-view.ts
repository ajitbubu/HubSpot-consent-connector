/**
 * Preference Center / Auditor view generator.
 * Renders .consent-db.json into a self-contained HTML page: current consent
 * per person + the full append-only event log with evidence (hashes, source
 * references, notice versions, actors) + downstream delivery receipts.
 *
 * Run: npx tsx scripts/build-audit-view.ts   → writes audit-view.html
 */

import { writeFileSync } from "node:fs";
import { FileConsentDb, type ConsentDbEvent } from "../src/platform/testing/file-consent-db.js";
import { CONSENT_DB_FILE, loadDotEnv } from "./_shared.js";

const OUT = new URL("../audit-view.html", import.meta.url);

function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function statusPill(status: string): string {
  const cls = status === "GRANTED" ? "ok" : status === "WITHDRAWN" ? "bad" : "unk";
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}

function evidenceCell(event: ConsentDbEvent): string {
  const parts: string[] = [`<b>${esc(event.evidence.method)}</b>`];
  if (event.evidence.actor) parts.push(`actor: ${esc(event.evidence.actor)}`);
  if (event.evidence.noticeVersion) parts.push(`notice: ${esc(event.evidence.noticeVersion)}`);
  if (event.evidence.explanation) parts.push(esc(event.evidence.explanation));
  if (event.evidence.sourceRef) parts.push(`<code>${esc(event.evidence.sourceRef)}</code>`);
  if (event.evidence.payloadHash) parts.push(`<code>${esc(event.evidence.payloadHash.slice(0, 26))}…</code>`);
  if (event.evidence.idempotencyKey) parts.push(`<code>${esc(event.evidence.idempotencyKey.slice(0, 20))}…</code>`);
  return parts.join("<br>");
}

function main(): void {
  loadDotEnv();
  const db = new FileConsentDb(CONSENT_DB_FILE);
  const { parties, events, receipts } = db.snapshot();
  const purposes = [...new Set(events.map((e) => e.purposeCode).filter(Boolean))] as string[];

  const partyCards = Object.values(parties)
    .map((party) => {
      const partyEvents = events.filter((e) => e.partyId === party.partyId);
      if (partyEvents.length === 0) return "";
      const stateRow = purposes
        .map((purpose) => {
          const state = db.effectiveState(party.partyId, purpose);
          return `<td>${state ? statusPill(state.status) + `<span class="v">v${state.version}</span>` : '<span class="pill unk">NO RECORD</span>'}</td>`;
        })
        .join("");
      const log = partyEvents
        .map(
          (e) => `<tr>
            <td class="mono">${esc(e.recordedAt.slice(0, 19).replace("T", " "))}</td>
            <td>${esc(e.purposeCode ?? "(unmapped)")}</td>
            <td class="mono">${esc(e.status)}</td>
            <td>${statusPill(e.derivedStatus)}</td>
            <td><span class="origin ${e.origin === "PREFERENCE_CENTER" ? "pc" : "hs"}">${e.origin === "PREFERENCE_CENTER" ? "Preference Center" : "HubSpot"}</span></td>
            <td class="mono">v${e.consentVersion}</td>
            <td class="ev">${evidenceCell(e)}</td>
          </tr>`,
        )
        .join("");
      return `<section class="party">
        <header>
          <h2>${esc([party.firstName, party.lastName].filter(Boolean).join(" ") || "(no name)")}</h2>
          <span class="mono soft">${esc(party.emailNormalized ?? "no email")} · ${esc(party.partyId)} · HubSpot contact ${esc(party.contactId)}</span>
        </header>
        <table class="state"><thead><tr>${purposes.map((p) => `<th>${esc(p)}</th>`).join("")}</tr></thead>
        <tbody><tr>${stateRow}</tr></tbody></table>
        <details ${partyEvents.some((e) => e.origin === "PREFERENCE_CENTER") ? "open" : ""}>
          <summary>Consent record log — ${partyEvents.length} event(s), append-only</summary>
          <div class="scroll"><table class="log">
            <thead><tr><th>Recorded (UTC)</th><th>Purpose</th><th>Source status</th><th>Derived</th><th>Origin</th><th>Ver</th><th>Evidence</th></tr></thead>
            <tbody>${log}</tbody>
          </table></div>
        </details>
      </section>`;
    })
    .join("\n");

  const receiptRows = receipts
    .map(
      (r) => `<tr>
        <td class="mono">${esc(r.deliveryId.slice(0, 12))}…</td>
        <td class="mono">${esc(r.changeId ?? "")}</td>
        <td>${r.status === "DELIVERED" ? '<span class="pill ok">DELIVERED</span>' : `<span class="pill unk">${esc(r.status)}</span>`}</td>
        <td class="mono">contact ${esc(r.destinationRecordId)}</td>
        <td class="mono">v${esc(r.consentVersion)}</td>
        <td class="mono">${esc(r.deliveredAt?.slice(0, 19).replace("T", " ") ?? "—")}</td>
      </tr>`,
    )
    .join("");

  const html = `<title>Consent Records — Preference Center / Audit View</title>
<style>
  :root { --bg:#FAFAF7; --surface:#FFFFFF; --alt:#F1F2ED; --ink:#1C2321; --soft:#55605C; --line:#DDE0D8;
          --accent:#0F6B5C; --accent-soft:#E3EFEB; --bad:#A03A2E; --bad-soft:#F7E6E2; --mono:#EEF0EA; }
  :root:not([data-theme="light"]) { @media (prefers-color-scheme: dark) {
    --bg:#141817; --surface:#1B211F; --alt:#202725; --ink:#E6E9E4; --soft:#9BA6A0; --line:#2E3733;
    --accent:#55C3AC; --accent-soft:#1D2F2A; --bad:#E08A7A; --bad-soft:#33211D; --mono:#232B28; } }
  :root[data-theme="dark"] {
    --bg:#141817; --surface:#1B211F; --alt:#202725; --ink:#E6E9E4; --soft:#9BA6A0; --line:#2E3733;
    --accent:#55C3AC; --accent-soft:#1D2F2A; --bad:#E08A7A; --bad-soft:#33211D; --mono:#232B28; }
  * { box-sizing:border-box; }
  body { background:var(--bg); color:var(--ink); margin:0; padding:2.5rem 1.25rem 4rem;
         font:15px/1.6 -apple-system,"Segoe UI",Roboto,Arial,sans-serif; }
  .page { max-width:1000px; margin:0 auto; }
  h1 { font-family:Charter,Cambria,Georgia,serif; font-size:1.9rem; margin:0 0 .3rem; }
  .meta { color:var(--soft); font-size:.85rem; margin:0 0 1.5rem; }
  .mono { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:.82em; }
  .soft { color:var(--soft); }
  code { font-family:ui-monospace,"SF Mono",Menlo,monospace; font-size:.78em; background:var(--mono);
         padding:.06em .3em; border-radius:4px; }
  section.party { background:var(--surface); border:1px solid var(--line); border-radius:10px;
                  padding:1.1rem 1.25rem; margin:1rem 0; }
  section.party header { display:flex; flex-wrap:wrap; align-items:baseline; gap:.75rem; margin-bottom:.6rem; }
  section.party h2 { font-size:1.05rem; margin:0; }
  table { border-collapse:collapse; width:100%; font-size:.84rem; }
  th,td { text-align:left; padding:.45rem .65rem; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  th { font-size:.68rem; text-transform:uppercase; letter-spacing:.07em; color:var(--soft); }
  table.state { margin-bottom:.5rem; } table.state td { border-bottom:none; }
  .scroll { overflow-x:auto; }
  .pill { display:inline-block; font-size:.72rem; font-weight:700; padding:.08rem .55rem; border-radius:999px; }
  .pill.ok { background:var(--accent-soft); color:var(--accent); }
  .pill.bad { background:var(--bad-soft); color:var(--bad); }
  .pill.unk { background:var(--alt); color:var(--soft); border:1px solid var(--line); }
  .v { margin-left:.45rem; color:var(--soft); font-size:.75rem; }
  .origin { font-size:.75rem; font-weight:600; }
  .origin.pc { color:var(--accent); } .origin.hs { color:var(--soft); }
  .ev { font-size:.78rem; color:var(--soft); max-width:34ch; }
  details summary { cursor:pointer; font-size:.85rem; color:var(--soft); margin:.4rem 0 .5rem; }
  h2.sec { font-family:Charter,Cambria,Georgia,serif; font-size:1.3rem; margin:2.2rem 0 .6rem; }
  .note { background:var(--alt); border:1px solid var(--line); border-radius:8px; padding:.8rem 1rem;
          font-size:.84rem; color:var(--soft); max-width:78ch; }
</style>
<div class="page">
  <h1>Consent Records</h1>
  <p class="meta">Preference Center / Auditor view · generated ${esc(new Date().toISOString().slice(0, 19).replace("T", " "))} UTC ·
    ${Object.keys(parties).length} data principals · ${events.length} consent events (append-only) · ${receipts.length} downstream delivery receipt(s)</p>
  <p class="note"><b>How to read this:</b> each person's current consent per purpose is derived from their
    append-only event log below it — records are never edited or deleted. <b>UNKNOWN</b> means the source
    reported <code>NOT_SUBSCRIBED</code>, which cannot distinguish "withdrew" from "never chose"; it becomes
    WITHDRAWN or GRANTED only via corroborated evidence. Preference-center actions carry actor + notice
    version; HubSpot-sourced events carry the source reference, payload hash, and idempotency key.</p>
  ${partyCards}
  <h2 class="sec">Downstream delivery receipts (enforcement audit trail)</h2>
  <div class="scroll"><table>
    <thead><tr><th>Delivery</th><th>Change</th><th>Result</th><th>Destination</th><th>Version</th><th>Delivered (UTC)</th></tr></thead>
    <tbody>${receiptRows || '<tr><td colspan="6" class="soft">No deliveries yet</td></tr>'}</tbody>
  </table></div>
</div>`;

  writeFileSync(OUT, html);
  console.log(`✓ audit-view.html written (${Object.keys(parties).length} parties, ${events.length} events, ${receipts.length} receipts)`);
}

main();
