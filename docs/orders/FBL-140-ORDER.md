# FBL-140 — Deal Jacket, Documents, and E-Sign Evidence — THE ORDER

**Provenance.** This is the architect's order for FBL-140, received under Standing Architect
Order SO-001 (Master Blueprint **Version 3.1**,
`docs/orders/Car_Dealership_Management_and_Sales_Cloud_Master_Blueprint_v3.1.docx`, sha256
`c57894f4c0018e7d36afc3e7255eeb17d80b2b3899d5ba44ebd1956a1ee93979`) on 2026-09-05, in the
same message that ordered FBL-120 closed. Unlike FBL-120's seven rows, which were quoted out of
the Version 3.1 document's own bytes, FBL-140's eight locked outcomes arrived as order text and
are committed here VERBATIM — the text below, from "B. Immediately begin FBL-140" to "Do not
begin FBL-150 until the next architect order", is the order as received, unedited, including its
own typographical slips ("and, and and evidence"). `docs/FBL-140-ACCEPTANCE-ROWS.json` quotes
each outcome from this file, and `scripts/check-fbl140-rows.ts` refuses a quotation these bytes
do not contain.

**Locked before** migration `066` existed: the rows record was written and committed with every
row at LOCKED and no test named, and the first product commit of the phase follows it.

---

B. Immediately begin FBL-140 After FBL-120 is closed and migration `065` is frozen, begin: FBL-140 — Deal Jacket, Documents, and E-Sign Evidence Start all new schema at migration `066`. Objective From one exact, current, manager-approved FBL-120 desking version, produce an immutable, version-bound, auditable deal-jacket and document-signing package ready for the later limited F&I and funding workflow. FBL-140 may create the deal-jacket/document aggregate. It must not declare a sale, funding, delivery, sold vehicle, accounting entry, or revenue event. Locked outcomes

1. Canonical intake and identity Consume the exact approved desking version through FBL-120’s public interface or published fact. Bind tenant, legal entity, rooftop, opportunity, party, selected stock, trade/appraisal context, approved scenario version, and rule versions. Retry and concurrency must converge without duplicate active jackets.
2. Versioned checklist and document requirements Resolve requirements from typed, effective-dated legal-entity, rooftop, jurisdiction, transaction-type, and template configuration. Every requirement must show its source and version. Missing required items block progression. Any permitted waiver requires authorized actor, reason, policy version, and, and and evidence.
3. Deterministic package assembly Assemble fields from canonical records without operator rekeying or copied shadow truth. Every financial figure must exactly match the approved FBL-120 version and preserve currency and fixed-decimal semantics. Record field provenance and source versions.
4. Immutable rendering and artifacts Render versioned document packages deterministically. Bind each artifact to package version, template version, content hash, MIME type, size, classification, malware result, retention policy, and legal-hold state. A changed input creates a new superseding version; it never mutates a rendered or signed package.
5. E-sign ceremony and evidence Capture electronic-record consent, signer identity and role, signing authority, authentication assurance, intent, exact package version/hash, timestamps, provider delivery records, signature results, and completion certificate. Provider callbacks must be signed, idempotent, replay-safe, and reconcilable. A signer cannot sign a superseded or modified package.
6. Lifecycle and operational exceptions Support coherent states equivalent to draft, review-ready, sent, partially signed, signed-complete, voided, expired, and superseded. Terminal states are absorbing except through explicit versioned supersession. Expose actionable queues for missing documents, render failure, rejected or expired signatures, provider failure, and stale approved-desking inputs.
7. Authorization, isolation, and privacy Enforce tenant and rooftop RLS, tenant-qualified parent binding, non-disclosing authorization, optimistic concurrency, idempotency, audit/outbox atomicity, short-lived artifact access, PII-safe logs/events, retention, export, and legal holds. Sales staff, managers, customer signers, support actors, and system/provider callbacks must use distinct authority lanes.
8. Real persisted user journey Demonstrate the shipped UI without raw UUID entry:
   * salesperson opens the approved desking result and assembles the jacket;
   * required documents and missing items are visible;
   * an authorized manager completes any configured review;
   * a separate customer identity receives, reviews, consents, and signs the exact package;
   * staff sees the completed certificate and immutable timeline;
   * an unauthorized user cannot approve or sign for another actor;
   * package supersession preserves the earlier package, figures, signatures, and decisions.

Hard exclusions FBL-140 must not implement:

* credit applications, bureau pulls, lender routing or decisions;
* F&I product menus or contracting;
* funding or receivable approval;
* title or registration completion;
* vehicle delivery or sold-inventory transition;
* payment settlement or accounting posting;
* gross, commission, or revenue recognition;
* advanced digital retail;
* Fixed Operations expansion.

Do not invent legal forms or claim that sample templates are jurisdictionally approved. Store the exact template source, approval status, jurisdiction, effective interval, and accountable approver. Verification and closure Keep the FBL-140 PR Draft until implementation and evidence are complete. Use proportional focused tests during development, followed by:

* one complete local battery;
* all declared runtime and database-control mutation registries with zero survivors and green baselines;
* fresh and upgraded database convergence;
* proof that migrations `000–065` remain byte-identical and only forward migration `066+` is added;
* persisted multi-identity UI journey;
* artifact hash/version and signature replay proof;
* exact-SHA CI;
* Ready status and merge of the exact verified SHA;
* green post-merge `main` state.

Do not create arbitrary test, mutation, commit, or evidence counts. Return only for a genuine external dependency or after FBL-140 is merged, closed, and its migrations are frozen. Do not begin FBL-150 until the next architect order.
