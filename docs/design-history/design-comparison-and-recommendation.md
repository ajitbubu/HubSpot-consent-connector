# HubSpot Consent Connector — 3-Way Design Comparison & Recommendation

**Date:** 2026-08-10
**Documents compared:**

- **Doc A** — `HubSpot-Sentinel-Consent-Connector-Architecture-API-Specification.md` (v1.0, 2026-08-03) — "Sentinel spec"
- **Doc B** — `hubspot-consent-connector-implementation-handoff.md` (2026-08-10) — "Implementation handoff"
- **Doc C** — `meta-ai-consent-sol.md` (v1.0, dated 2026-05-11) — "DSG PMP quick-start"

**Question evaluated:** Which design is accurate and complete for the closed loop — *connect to HubSpot → pull consent data → store in the central consent DB → push effective consent back to HubSpot*?

**Verdict (unchanged by Doc C):** **Doc B is the build specification. Doc A is the policy layer. Doc C is a proof-of-concept sketch** — useful for a demo in days, but it contains verified factual errors against HubSpot's API and consent logic that would fail compliance review. Do not build production from it.

---

## 1. What each document is

| | Doc A — Sentinel spec | Doc B — Implementation handoff | Doc C — DSG quick-start |
| --- | --- | --- | --- |
| Altitude | Governance / architecture proposal | Implementation-ready engineering spec | PoC runbook (FastAPI + Redis + docker-compose) |
| Audience | Privacy owners, architects | Engineers / coding agents | A developer standing up a demo |
| Tenancy | Multi-tenant OAuth | Multi-tenant OAuth (or private app for one account) | Single portal, private-app token only |
| Sync model | Webhooks + delta polling + reconciliation | Webhooks + delta polling + reconciliation | Webhooks + one-time backfill only |
| Scope | HubSpot ↔ Sentinel | HubSpot ↔ UCM | HubSpot ↔ DSG, with fan-out to Salesforce/Outreach/Highspot |
| Time to first demo | Months | Weeks | Days |
| Production-ready | Needs mechanics | **Yes (as a spec)** | No |

## 2. Doc C — what it gets right

- **Fastest path to a working demo:** private app, 3 webhook subscriptions, FastAPI receiver, Redis Stream worker, docker-compose, `.env`, backfill script, curl test. Nothing else in the folder is this runnable.
- **Right instincts on the basics:** ack webhooks fast and process async; fetch the full contact after a webhook; append-only receipt table written before the operational upsert; "most restrictive wins"; backfill before go-live so historical opt-outs aren't lost; simple queue-depth and insert-rate alerts.
- **Raises a real coverage concern:** footer unsubscribes must be captured, not just `hs_email_optout` property changes (though its proposed mechanism is unverified — see below).
- **Multi-system vision:** outbox fan-out to Salesforce, Outreach, Highspot with `exclude_source` matches where this connector list is heading.

## 3. Doc C — verified errors and gaps

Checked against HubSpot's current documentation (Communication Preferences v3 guide, Webhooks guide):

1. **Loop prevention does not work as described.** It sends an `X-Source: consent-service` HTTP header on the CRM write and claims "HubSpot will echo this back in webhook." HubSpot does **not** echo caller headers into webhook payloads; payloads carry `changeSource` (and app attribution), not arbitrary headers. Every DSG→HubSpot write would echo back as an inbound event and be re-processed. Doc B's mechanism (write `consent_version` + `consent_correlation_id` as contact properties and match them on the inbound side) is the correct one.
2. **Wrong preference endpoint.** `GET /communication-preferences/v3/status/{id}` — the documented endpoint is keyed by **email**, not contact ID: `GET /communication-preferences/v3/status/email/{emailAddress}` (Docs A and B both have this right).
3. **Invalid resubscribe path.** `unsubscribe_from_all` is not a documented v3 operation, and v3 explicitly **cannot resubscribe** a contact who previously opted out (v4 is required, with explicit-permission constraints). Doc C's opt-in branch (`hs_email_optout=false`) is exactly the "clearing an opt-out is not renewed consent" anti-pattern Docs A and B prohibit.
4. **Unverified webhook type.** `contact.subscriptionStatusChange` is not in HubSpot's documented webhook subscription list (creation, deletion, merge, associationChange, restore, privacyDeletion, propertyChange). The underlying concern is valid — footer unsubscribes must be captured — but the reliable documented path is polling/reconciling the Communication Preferences API, as Docs A and B specify.
5. **Signature formula mislabeled.** `base64(sha256(secret + body))` is the v1 scheme; v3 is an HMAC-SHA256 over method + URI + body + timestamp with the app secret as the HMAC key. Implemented as written, every webhook would fail validation (or force a downgrade to v1).
6. **Consent from absence.** Its transform makes anyone *not* opted out `OPT_IN` — a consent grant inferred from missing evidence, with no notice version, affirmative action, or evidence retention. This is the core rule Docs A and B are built around ("missing evidence never becomes GRANTED") and it would fail GDPR/DPDP review despite Doc C citing GDPR Article 7.
7. **Email as the person's primary key.** `email.lower() → data_subject_id`, operational PK `(email_plain, purpose)`, plaintext emails stored. Shared/duplicate emails silently collapse into one person; contradicts Doc B's composite source key and both docs' quarantine rules; ignores merges and deletions entirely (no `contact.merge`/`privacyDeletion` handling).
8. **Reliability gaps.** No delta sync or scheduled reconciliation (a missed webhook is lost forever after the one-time backfill); dedup is a 24-hour Redis `SETEX` (a restart forgets processed events); "outbox" is a Redis publish, not a same-transaction outbox; the staleness guard compares to `NOW()` instead of the incoming event's source timestamp, so out-of-order updates can overwrite newer state; ngrok appears in the deployment checklist.

## 4. Stage-by-stage scores

| Stage | Doc A | Doc B | Doc C |
| --- | --- | --- | --- |
| Connect to HubSpot | Policy only | **Full OAuth lifecycle + private-app option, scope validation** | Private app only; correct scopes; single tenant |
| Pull consent data | Abstract adapter, no real APIs | **Real endpoints, pagination, watermark deltas, webhook flow, reconciliation** | Webhooks + backfill; wrong preference endpoint; no recovery path |
| Store in consent DB | Strong evidence model, no mechanics | **Identity mapping w/ SQL constraint, versioned events, effective-state key, transactional outbox** | Simple receipt + upsert; email-keyed identity; grants from absence |
| Push back to HubSpot | Conceptual | **PATCH + native preference sync, version rules, working loop prevention, DLQ** | Broken loop prevention; invalid resubscribe; no versioning |
| Compliance | **Exhaustive (DPDP, evidence, precedence)** | Good | Fails its own GDPR bar (rule 6 above) |
| Operability | Metrics list | **Reconciliation, eligibility API, dashboards, replay** | Basic alerts; demo-grade deploy |

**Ranking for the closed loop: B > A > C.** (A outranks C because A is *incomplete but correct*; C is *complete-looking but wrong* in five verified places, which is more dangerous.)

## 5. Recommendation

1. **Build from Doc B** — unchanged from the previous review: OAuth lifecycle, initial pull, native preference read, webhooks + delta + reconciliation, identity resolution with quarantine, immutable events, transactional outbox, version-aware writeback to custom properties **and** native subscription status, correlation-ID loop prevention, eligibility API.
2. **Govern with Doc A** — fold its never-consent list, grant-evidence requirements, precedence rules, reconciliation taxonomy, and DPDP/responsibility content into Doc B's validation and reporting layers.
3. **Use Doc C only as a PoC accelerator**, with corrections: its docker-compose skeleton, webhook receiver shape (fast-ack + Redis Stream worker), and backfill script are fine scaffolding for Doc B's Phase 1–2 — after fixing the preference endpoint, the v3 signature, and the loop-prevention mechanism, and deleting the opt-in-from-absence transform.
4. **Adopt Doc C's one good challenge into Doc B's plan:** explicitly verify during implementation how footer unsubscribes are detected in your portal (webhook availability vs. preference polling cadence), and make preference polling frequency a tenant-level SLA.
5. **Do not adopt from Doc C:** header-based loop prevention, email-as-primary-key identity, resubscribe-on-grant writeback, webhook-only sync without reconciliation.

**One-line summary:** Doc B tells you *how* to build it correctly, Doc A tells you *what counts as consent*, and Doc C shows how to demo it fast — but only B + A can go to production.
