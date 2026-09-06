-- ============================================================================
-- FBL-140 — DEAL JACKET, DOCUMENTS AND E-SIGN EVIDENCE
--
-- One phase over the immutable 000–065 chain. It begins where FBL-120 stopped:
-- ONE manager-approved desking version is the seam, and a deal jacket is opened
-- FROM it rather than beside it, so a document package cannot be assembled
-- from figures nobody approved.
--
--   1. CONFIGURATION — document templates and document requirements, each
--      typed, effective-dated, scoped to a legal entity, rooftop and
--      jurisdiction, versioned, and never overlapping.
--   2. THE JACKET — the approved version consumed exactly once, every canonical
--      input it binds recorded with its version, and the checklist resolved
--      from configuration at the instant it was opened.
--   3. THE PACKAGE — a versioned, immutable assembly of fields with their
--      provenance, and the rendered artifacts, each bound to its content hash.
--   4. THE CEREMONY — signers, their consent, their intent and their
--      signatures, and an append-only event stream a provider cannot replay
--      into twice.
--   5. RETENTION AND LEGAL HOLD — a policy every artifact names, and a hold that
--      is placed and lifted as history rather than flipped.
--   6. THE GRANTS the runtime role needs. DELETE is granted NOWHERE.
--   7. THE RESOURCE REGISTRY — both resolvers re-declared.
--   8. DENY-BY-DEFAULT ROW SECURITY over every table this phase adds.
--   9. THE TRIGGERS that make a rendered or signed package immutable in the
--      database rather than merely in the service that writes it.
--
-- WHAT A JACKET IS ALLOWED TO BE. The complete set of documents a customer and
-- the dealership sign for a deal the desk has already approved, and the
-- evidence that they signed exactly those documents. It is READY for the
-- limited F&I and funding workflow that follows. It is not that workflow.
--
-- WHAT THIS PHASE DELIBERATELY DOES NOT DO, so the omissions read as decisions:
--
--   * NO SALE, NO FUNDING, NO DELIVERY, NO SOLD VEHICLE, NO ACCOUNTING ENTRY,
--     NO REVENUE. There is still no `sales`, `deals`, `deliveries` or
--     `sold_inventory` table, migration 063's `ck_attribution_pre_sale_revenue`
--     is still in force, and a signed package moves no money and changes no
--     stock item. A signature here is evidence that a person signed a document,
--     which is a fact about a document.
--   * NO CREDIT APPLICATION, BUREAU PULL, LENDER ROUTING OR DECISION; NO F&I
--     MENU OR PRODUCT CONTRACT; NO TITLE OR REGISTRATION; NO PAYMENT. The
--     exclusion list of the FBL-140 order names each of them and later phases
--     own them.
--   * NO INVENTED LEGAL FORMS. A template row records where its text came from,
--     which jurisdiction it claims, whether anybody accountable APPROVED it for
--     that jurisdiction, and who. The default is `unapproved_sample`, and a
--     package rendered from one carries that status on every document, because a
--     sample that reads as a statutory form is the one lie this table exists to
--     make unrepresentable.
--   * NO PROVIDER IS INTEGRATED. `provider_code` on a ceremony names a
--     deterministic simulator as what it is. The callback lane, the event
--     ledger and the replay refusal are real; the provider behind them is not
--     pretended to be.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- Section 1 — CONFIGURATION: TEMPLATES AND REQUIREMENTS
--
-- Both tables use the shape migration 065 gave the desking rule book: a
-- (kind, code) pair versioned by a new ROW, scoped by jurisdiction and an
-- optional legal entity and rooftop, bounded by an effective interval, and
-- refused by a GiST exclusion constraint when two versions would be in force
-- over one instant. A checklist that could resolve two answers cannot say what
-- the deal needs, and the only cheap place to refuse that is the write.
--
-- SPECIFICITY is decided at resolution, once, in the service: a rooftop's own
-- row beats its legal entity's, which beats the tenant's. They cannot collide
-- in the database because the scope is part of the exclusion key.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE document_templates (
  template_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  template_code           TEXT NOT NULL CHECK (template_code ~ '^[a-z0-9_]{2,40}$'),
  version                 INTEGER NOT NULL CHECK (version >= 1),
  title                   TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  document_kind           TEXT NOT NULL
                            CHECK (document_kind IN ('contract', 'disclosure', 'acknowledgement',
                                                     'supporting')),
  jurisdiction            TEXT NOT NULL CHECK (jurisdiction ~ '^[A-Z0-9-]{2,40}$'),
  -- NULL means every entity / every rooftop in the tenant.
  legal_entity_id         UUID,
  rooftop_id              UUID,
  transaction_type        TEXT NOT NULL
                            CHECK (transaction_type IN ('retail_cash', 'retail_finance', 'any')),
  -- WHERE THE TEXT CAME FROM. A publisher, a statute, a counsel memo, or the
  -- honest words "FBL-140 sample". NOT NULL because a form nobody can attribute
  -- is a form somebody typed.
  source                  TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 300),
  approval_status         TEXT NOT NULL DEFAULT 'unapproved_sample'
                            CHECK (approval_status IN ('unapproved_sample', 'approved', 'withdrawn')),
  approved_by_user_link_id UUID,
  approved_at             TIMESTAMPTZ,
  approval_reference      TEXT CHECK (approval_reference IS NULL OR length(approval_reference) <= 200),
  effective_from          TIMESTAMPTZ NOT NULL,
  effective_to            TIMESTAMPTZ,
  -- The template body: text with {{field_code}} placeholders the renderer
  -- fills from the package's assembled fields, and nothing else. Its digest is
  -- what a rendered document later names as `template_sha256`.
  body_template           TEXT NOT NULL CHECK (length(body_template) BETWEEN 1 AND 200000),
  body_sha256             TEXT NOT NULL CHECK (body_sha256 ~ '^[0-9a-f]{64}$'),
  -- Who must sign a document rendered from this template, in signing order.
  required_signer_roles   TEXT[] NOT NULL DEFAULT ARRAY['customer']::text[],
  recorded_by_user_link_id UUID NOT NULL,
  recorded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, template_id),
  UNIQUE (tenant_id, template_code, version),
  CONSTRAINT ck_template_interval CHECK (effective_to IS NULL OR effective_to > effective_from),
  -- AN APPROVAL NAMES WHO AND WHEN, OR IT IS NOT AN APPROVAL.
  CONSTRAINT ck_template_approval_is_attributed CHECK (
    (approval_status = 'approved'
       AND approved_by_user_link_id IS NOT NULL AND approved_at IS NOT NULL)
    OR
    (approval_status <> 'approved'
       AND approved_by_user_link_id IS NULL AND approved_at IS NULL)
  ),
  CONSTRAINT ck_template_signer_roles CHECK (
    required_signer_roles <@ ARRAY['customer', 'co_buyer', 'dealer_representative']::text[]
    AND cardinality(required_signer_roles) >= 1
  ),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities (tenant_id, legal_entity_id),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, recorded_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, approved_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id),
  CONSTRAINT uq_document_templates_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    template_code WITH =,
    jurisdiction WITH =,
    transaction_type WITH =,
    (COALESCE(legal_entity_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (COALESCE(rooftop_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  )
);
CREATE INDEX idx_document_templates_lookup
  ON document_templates (tenant_id, jurisdiction, transaction_type, effective_from DESC);

CREATE TABLE document_requirements (
  requirement_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  requirement_code        TEXT NOT NULL CHECK (requirement_code ~ '^[a-z0-9_]{2,40}$'),
  version                 INTEGER NOT NULL CHECK (version >= 1),
  label                   TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
  jurisdiction            TEXT NOT NULL CHECK (jurisdiction ~ '^[A-Z0-9-]{2,40}$'),
  legal_entity_id         UUID,
  rooftop_id              UUID,
  transaction_type        TEXT NOT NULL
                            CHECK (transaction_type IN ('retail_cash', 'retail_finance', 'any')),
  -- A requirement is satisfied by a RENDERED document from a template, or by
  -- EVIDENCE somebody supplies (an insurance card, an identity check). Exactly
  -- one of the two says how.
  satisfied_by            TEXT NOT NULL CHECK (satisfied_by IN ('template', 'evidence')),
  template_code           TEXT CHECK (template_code IS NULL OR template_code ~ '^[a-z0-9_]{2,40}$'),
  evidence_kind           TEXT CHECK (evidence_kind IS NULL OR evidence_kind ~ '^[a-z0-9_]{2,40}$'),
  required                BOOLEAN NOT NULL DEFAULT TRUE,
  waivable                BOOLEAN NOT NULL DEFAULT FALSE,
  source                  TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 300),
  effective_from          TIMESTAMPTZ NOT NULL,
  effective_to            TIMESTAMPTZ,
  recorded_by_user_link_id UUID NOT NULL,
  recorded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, requirement_id),
  UNIQUE (tenant_id, requirement_code, version),
  CONSTRAINT ck_requirement_interval CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT ck_requirement_names_its_satisfier CHECK (
    (satisfied_by = 'template' AND template_code IS NOT NULL AND evidence_kind IS NULL)
    OR
    (satisfied_by = 'evidence' AND evidence_kind IS NOT NULL AND template_code IS NULL)
  ),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities (tenant_id, legal_entity_id),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, recorded_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id),
  CONSTRAINT uq_document_requirements_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    requirement_code WITH =,
    jurisdiction WITH =,
    transaction_type WITH =,
    (COALESCE(legal_entity_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    (COALESCE(rooftop_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  )
);
CREATE INDEX idx_document_requirements_lookup
  ON document_requirements (tenant_id, jurisdiction, transaction_type, effective_from DESC);

-- A retention policy is configuration too: a code, a version, how long, and who
-- says so. Every rendered artifact names one, so "how long do we keep this" is
-- answered by a row rather than by a meeting.
CREATE TABLE retention_policies (
  retention_policy_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  policy_code             TEXT NOT NULL CHECK (policy_code ~ '^[a-z0-9_]{2,40}$'),
  version                 INTEGER NOT NULL CHECK (version >= 1),
  label                   TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
  retain_for_days         INTEGER NOT NULL CHECK (retain_for_days BETWEEN 1 AND 36500),
  source                  TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 300),
  effective_from          TIMESTAMPTZ NOT NULL,
  effective_to            TIMESTAMPTZ,
  recorded_by_user_link_id UUID NOT NULL,
  recorded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, retention_policy_id),
  UNIQUE (tenant_id, policy_code, version),
  CONSTRAINT ck_retention_interval CHECK (effective_to IS NULL OR effective_to > effective_from),
  FOREIGN KEY (tenant_id, recorded_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id),
  CONSTRAINT uq_retention_policies_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    policy_code WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  )
);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 2 — THE JACKET
--
-- OPENED FROM ONE APPROVED VERSION, EXACTLY ONCE. `(tenant_id, approved_scenario_id)`
-- is unique, and migration 065 already makes an approved version unique per
-- desking case — so "one active jacket per deal" is two keys deep. A retry or
-- a concurrent open converges on the jacket that exists, exactly as the desk
-- converges on its file.
--
-- WHAT IS BOUND, AND WHY IT IS COPIED. The rooftop, legal entity, customer,
-- stock item, appraisal version, approved scenario version and its
-- `output_fingerprint` are copied at open. `jacket_source_bindings` then names
-- EVERY canonical record and version the package will be assembled from, so a
-- reader can ask "what was this built from" and get versions rather than a join
-- to whatever those records say today. When the desk later approves a NEWER
-- version, the jacket's bound fingerprint no longer matches the case's current
-- approved version, and the board calls that what it is: stale.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE deal_jackets (
  jacket_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  legal_entity_id         UUID NOT NULL,
  rooftop_id              UUID NOT NULL,
  desking_case_id         UUID NOT NULL,
  opportunity_id          UUID NOT NULL,
  party_id                UUID NOT NULL,
  stock_item_id           UUID,
  appraisal_id            UUID,
  appraisal_version_no    INTEGER CHECK (appraisal_version_no IS NULL OR appraisal_version_no >= 1),
  approved_scenario_id    UUID NOT NULL,
  scenario_version_no     INTEGER NOT NULL CHECK (scenario_version_no >= 1),
  approved_output_fingerprint TEXT NOT NULL CHECK (approved_output_fingerprint ~ '^[0-9a-f]{64}$'),
  approval_id             UUID NOT NULL,
  jurisdiction            TEXT NOT NULL CHECK (jurisdiction ~ '^[A-Z0-9-]{2,40}$'),
  transaction_type        TEXT NOT NULL CHECK (transaction_type IN ('retail_cash', 'retail_finance')),
  state                   TEXT NOT NULL DEFAULT 'open'
                            CHECK (state IN ('open', 'signed_complete', 'voided')),
  opened_by_user_link_id  UUID NOT NULL,
  opened_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, jacket_id),
  -- EXACTLY ONE JACKET PER APPROVED VERSION.
  UNIQUE (tenant_id, approved_scenario_id),
  CONSTRAINT ck_jacket_appraisal_pair
    CHECK ((appraisal_id IS NULL) = (appraisal_version_no IS NULL)),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entities (tenant_id, legal_entity_id),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, desking_case_id) REFERENCES desking_cases (tenant_id, desking_case_id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, opportunity_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, appraisal_id) REFERENCES appraisals (tenant_id, appraisal_id),
  FOREIGN KEY (tenant_id, approved_scenario_id)
    REFERENCES desking_scenarios (tenant_id, scenario_id),
  FOREIGN KEY (tenant_id, approval_id) REFERENCES scenario_approvals (tenant_id, approval_id),
  FOREIGN KEY (tenant_id, opened_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);
-- ONE ACTIVE JACKET PER DESKING CASE. A voided jacket steps aside; an open or
-- completed one does not.
CREATE UNIQUE INDEX uq_deal_jackets_one_active_per_case
  ON deal_jackets (tenant_id, desking_case_id) WHERE state <> 'voided';
CREATE INDEX idx_deal_jackets_rooftop ON deal_jackets (tenant_id, rooftop_id, state, opened_at);

CREATE TABLE jacket_source_bindings (
  binding_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  jacket_id               UUID NOT NULL,
  source_kind             TEXT NOT NULL
                            CHECK (source_kind IN ('party', 'stock_item', 'vehicle', 'appraisal_version',
                                                   'desking_scenario', 'scenario_approval',
                                                   'desking_rule', 'legal_entity', 'rooftop')),
  source_id               UUID NOT NULL,
  source_version          TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 80),
  source_fingerprint      TEXT CHECK (source_fingerprint IS NULL OR source_fingerprint ~ '^[0-9a-f]{64}$'),
  bound_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, binding_id),
  UNIQUE (tenant_id, jacket_id, source_kind, source_id),
  FOREIGN KEY (tenant_id, jacket_id) REFERENCES deal_jackets (tenant_id, jacket_id)
);

CREATE TABLE jacket_checklist_items (
  item_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  jacket_id               UUID NOT NULL,
  requirement_id          UUID NOT NULL,
  requirement_code        TEXT NOT NULL,
  requirement_version     INTEGER NOT NULL,
  requirement_source      TEXT NOT NULL,
  required                BOOLEAN NOT NULL,
  waivable                BOOLEAN NOT NULL,
  satisfied_by            TEXT NOT NULL CHECK (satisfied_by IN ('template', 'evidence')),
  template_code           TEXT,
  evidence_kind           TEXT,
  state                   TEXT NOT NULL DEFAULT 'missing'
                            CHECK (state IN ('missing', 'satisfied', 'waived')),
  satisfied_document_id   UUID,
  evidence_uri            TEXT CHECK (evidence_uri IS NULL OR length(evidence_uri) <= 500),
  evidence_sha256         TEXT CHECK (evidence_sha256 IS NULL OR evidence_sha256 ~ '^[0-9a-f]{64}$'),
  -- A WAIVER IS FOUR THINGS OR IT IS NOTHING: who, why, under which policy
  -- version, and with what evidence.
  waived_by_user_link_id  UUID,
  waiver_reason           TEXT CHECK (waiver_reason IS NULL OR length(waiver_reason) BETWEEN 1 AND 500),
  waiver_policy_version   INTEGER,
  waiver_evidence_uri     TEXT CHECK (waiver_evidence_uri IS NULL OR length(waiver_evidence_uri) <= 500),
  waived_at               TIMESTAMPTZ,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, item_id),
  UNIQUE (tenant_id, jacket_id, requirement_code),
  CONSTRAINT ck_checklist_waiver_complete CHECK (
    (state <> 'waived'
       AND waived_by_user_link_id IS NULL AND waiver_reason IS NULL
       AND waiver_policy_version IS NULL AND waiver_evidence_uri IS NULL AND waived_at IS NULL)
    OR
    (state = 'waived' AND waivable
       AND waived_by_user_link_id IS NOT NULL AND waiver_reason IS NOT NULL
       AND waiver_policy_version IS NOT NULL AND waiver_evidence_uri IS NOT NULL
       AND waived_at IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, jacket_id) REFERENCES deal_jackets (tenant_id, jacket_id),
  FOREIGN KEY (tenant_id, requirement_id)
    REFERENCES document_requirements (tenant_id, requirement_id),
  FOREIGN KEY (tenant_id, waived_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_jacket_checklist_jacket ON jacket_checklist_items (tenant_id, jacket_id, state);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 3 — THE PACKAGE, ITS FIELDS AND ITS ARTIFACTS
--
-- A PACKAGE IS A VERSION, NOT A ROW THAT MOVES. Assembling again after an input
-- changed writes the NEXT version carrying `supersedes_package_id`; the earlier
-- one keeps every field, every rendered byte and every signature it collected.
-- The only column that ever changes on an existing package is `state`, and
-- section 9's trigger holds that true for every role.
--
-- FIELDS CARRY PROVENANCE. Every value names the table, row and version it was
-- read from. A financial field is `value_cents` with a currency and nothing
-- else — the same integer the desk approved, never re-typed, never re-computed.
--
-- BYTES ARE CONTENT-ADDRESSED. `document_blobs` is keyed by the sha256 of its
-- own bytes and a trigger recomputes the digest on insert, so a row whose key
-- lies about its content cannot exist. Two renders that produce the same bytes
-- share one blob, which is also what makes "deterministic rendering" a fact a
-- test can check: same package, same bytes, same key.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE jacket_packages (
  package_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  jacket_id               UUID NOT NULL,
  rooftop_id              UUID NOT NULL,
  version_no              INTEGER NOT NULL CHECK (version_no >= 1),
  supersedes_package_id   UUID,
  state                   TEXT NOT NULL DEFAULT 'draft'
                            CHECK (state IN ('draft', 'review_ready', 'sent', 'partially_signed',
                                             'signed_complete', 'voided', 'expired', 'superseded')),
  -- Digest over the assembled fields, in canonical form. Same inputs, same digest.
  fields_sha256           TEXT NOT NULL CHECK (fields_sha256 ~ '^[0-9a-f]{64}$'),
  -- Digest over the ordered list of rendered document digests: the PACKAGE hash
  -- a signer signs and a ceremony binds to.
  package_sha256          TEXT CHECK (package_sha256 IS NULL OR package_sha256 ~ '^[0-9a-f]{64}$'),
  document_count          INTEGER NOT NULL DEFAULT 0 CHECK (document_count >= 0),
  -- Whether every template this package was rendered from was APPROVED for its
  -- jurisdiction. Carried on the package so a screen cannot lose it.
  carries_unapproved_templates BOOLEAN NOT NULL DEFAULT FALSE,
  review_required         BOOLEAN NOT NULL DEFAULT FALSE,
  reviewed_by_user_link_id UUID,
  reviewed_at             TIMESTAMPTZ,
  assembled_by_user_link_id UUID NOT NULL,
  assembled_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ,
  state_reason            TEXT CHECK (state_reason IS NULL OR length(state_reason) <= 400),
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, package_id),
  UNIQUE (tenant_id, jacket_id, version_no),
  CONSTRAINT ck_package_supersedes_not_self
    CHECK (supersedes_package_id IS NULL OR supersedes_package_id <> package_id),
  CONSTRAINT ck_package_review_is_attributed
    CHECK ((reviewed_by_user_link_id IS NULL) = (reviewed_at IS NULL)),
  FOREIGN KEY (tenant_id, jacket_id) REFERENCES deal_jackets (tenant_id, jacket_id),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, supersedes_package_id) REFERENCES jacket_packages (tenant_id, package_id),
  FOREIGN KEY (tenant_id, assembled_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, reviewed_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);
-- ONE LIVE PACKAGE PER JACKET: whatever is not finished and not set aside.
CREATE UNIQUE INDEX uq_jacket_packages_one_live
  ON jacket_packages (tenant_id, jacket_id)
  WHERE state IN ('draft', 'review_ready', 'sent', 'partially_signed');
CREATE INDEX idx_jacket_packages_jacket ON jacket_packages (tenant_id, jacket_id, version_no DESC);

CREATE TABLE package_fields (
  field_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  package_id              UUID NOT NULL,
  field_code              TEXT NOT NULL CHECK (field_code ~ '^[a-z0-9_.]{2,60}$'),
  value_kind              TEXT NOT NULL CHECK (value_kind IN ('text', 'money', 'integer', 'rate_ppm', 'date')),
  value_text              TEXT CHECK (value_text IS NULL OR length(value_text) <= 2000),
  value_cents             BIGINT,
  value_integer           BIGINT,
  currency                TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  source_kind             TEXT NOT NULL CHECK (length(source_kind) BETWEEN 1 AND 40),
  source_id               UUID,
  source_version          TEXT NOT NULL CHECK (length(source_version) BETWEEN 1 AND 80),
  UNIQUE (tenant_id, field_id),
  UNIQUE (tenant_id, package_id, field_code),
  -- A MONEY FIELD IS AN INTEGER WITH A CURRENCY, AND NOTHING ELSE IS.
  CONSTRAINT ck_field_shape CHECK (
    (value_kind = 'money'    AND value_cents IS NOT NULL AND currency IS NOT NULL
                             AND value_text IS NULL AND value_integer IS NULL)
    OR (value_kind IN ('integer', 'rate_ppm') AND value_integer IS NOT NULL
                             AND value_cents IS NULL AND currency IS NULL AND value_text IS NULL)
    OR (value_kind IN ('text', 'date') AND value_text IS NOT NULL
                             AND value_cents IS NULL AND value_integer IS NULL AND currency IS NULL)
  ),
  FOREIGN KEY (tenant_id, package_id) REFERENCES jacket_packages (tenant_id, package_id)
);

CREATE TABLE document_blobs (
  content_sha256          TEXT PRIMARY KEY CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  mime_type               TEXT NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 120),
  byte_size               INTEGER NOT NULL CHECK (byte_size >= 1),
  content                 BYTEA NOT NULL,
  first_seen_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE package_documents (
  document_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  package_id              UUID NOT NULL,
  sequence_no             INTEGER NOT NULL CHECK (sequence_no >= 1),
  document_kind           TEXT NOT NULL
                            CHECK (document_kind IN ('contract', 'disclosure', 'acknowledgement',
                                                     'supporting', 'certificate')),
  title                   TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 160),
  template_id             UUID,
  template_code           TEXT,
  template_version        INTEGER,
  template_sha256         TEXT CHECK (template_sha256 IS NULL OR template_sha256 ~ '^[0-9a-f]{64}$'),
  template_approval_status TEXT
                            CHECK (template_approval_status IS NULL
                                   OR template_approval_status IN ('unapproved_sample', 'approved', 'withdrawn')),
  content_sha256          TEXT NOT NULL REFERENCES document_blobs (content_sha256),
  mime_type               TEXT NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 120),
  byte_size               INTEGER NOT NULL CHECK (byte_size >= 1),
  classification          TEXT NOT NULL
                            CHECK (classification IN ('customer_confidential', 'internal', 'public')),
  malware_scan_result     TEXT NOT NULL DEFAULT 'not_scanned'
                            CHECK (malware_scan_result IN ('not_scanned', 'clean', 'flagged')),
  malware_scanner         TEXT CHECK (malware_scanner IS NULL OR length(malware_scanner) <= 80),
  retention_policy_id     UUID NOT NULL,
  retention_policy_code   TEXT NOT NULL,
  retention_policy_version INTEGER NOT NULL,
  legal_hold              BOOLEAN NOT NULL DEFAULT FALSE,
  rendered_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, document_id),
  UNIQUE (tenant_id, package_id, sequence_no),
  CONSTRAINT ck_document_template_pair CHECK (
    (template_id IS NULL AND template_code IS NULL AND template_version IS NULL
       AND template_sha256 IS NULL AND template_approval_status IS NULL)
    OR
    (template_id IS NOT NULL AND template_code IS NOT NULL AND template_version IS NOT NULL
       AND template_sha256 IS NOT NULL AND template_approval_status IS NOT NULL)
  ),
  CONSTRAINT ck_document_scan_names_scanner
    CHECK ((malware_scan_result = 'not_scanned') = (malware_scanner IS NULL)),
  FOREIGN KEY (tenant_id, package_id) REFERENCES jacket_packages (tenant_id, package_id),
  FOREIGN KEY (tenant_id, template_id) REFERENCES document_templates (tenant_id, template_id),
  FOREIGN KEY (tenant_id, retention_policy_id)
    REFERENCES retention_policies (tenant_id, retention_policy_id)
);
CREATE INDEX idx_package_documents_package ON package_documents (tenant_id, package_id, sequence_no);

-- A checklist item satisfied by a rendered document names WHICH document: the
-- one in the live package version. Declared here because the documents table
-- had to exist first.
ALTER TABLE jacket_checklist_items
  ADD CONSTRAINT fk_checklist_satisfied_document
  FOREIGN KEY (tenant_id, satisfied_document_id) REFERENCES package_documents (tenant_id, document_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 4 — THE CEREMONY
--
-- A CEREMONY BINDS ONE PACKAGE VERSION BY HASH. `package_sha256` is copied onto
-- the ceremony when it is created; a signer signs THAT digest, and a signature
-- against a package whose digest has moved — or whose state is superseded — is
-- refused by section 9's trigger, not by the screen.
--
-- SIGNERS HAVE LANES. A customer signs through a short-lived token this table
-- stores only as a hash; a dealer representative signs through their staff
-- session. Neither can sign for the other: the row names its lane and the
-- identity that lane authenticates, and the signing service checks both.
--
-- CONSENT, IDENTITY, INTENT, SIGNATURE — FOUR INSTANTS, RECORDED SEPARATELY.
-- A signature without a prior consent to electronic records is refused; the
-- consent text version is recorded so a later dispute can read exactly what
-- was agreed to.
--
-- THE EVENT LEDGER IS APPEND-ONLY AND REPLAY-SAFE. Every event names the lane
-- it came from; a provider event carries the provider's own reference, and
-- `(tenant_id, provider_event_ref)` is unique — the second delivery of one
-- callback converges on the first rather than being recorded twice.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE signing_ceremonies (
  ceremony_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  jacket_id               UUID NOT NULL,
  package_id              UUID NOT NULL,
  rooftop_id              UUID NOT NULL,
  provider_code           TEXT NOT NULL CHECK (provider_code ~ '^[a-z0-9_]{2,40}$'),
  provider_kind           TEXT NOT NULL
                            CHECK (provider_kind IN ('deterministic_simulator', 'integrated_provider')),
  provider_envelope_ref   TEXT CHECK (provider_envelope_ref IS NULL OR length(provider_envelope_ref) <= 200),
  bound_package_sha256    TEXT NOT NULL CHECK (bound_package_sha256 ~ '^[0-9a-f]{64}$'),
  state                   TEXT NOT NULL DEFAULT 'created'
                            CHECK (state IN ('created', 'sent', 'in_progress', 'completed',
                                             'declined', 'expired', 'voided')),
  consent_text_version    TEXT NOT NULL CHECK (length(consent_text_version) BETWEEN 1 AND 40),
  sent_at                 TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  expires_at              TIMESTAMPTZ NOT NULL,
  -- The certificate is itself a content-addressed artifact: the digest names
  -- the exact bytes of the completion record a reader can fetch and re-hash.
  completion_certificate_sha256 TEXT REFERENCES document_blobs (content_sha256)
                            CHECK (completion_certificate_sha256 IS NULL
                                   OR completion_certificate_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_user_link_id UUID NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, ceremony_id),
  -- ONE CEREMONY PER PACKAGE VERSION.
  UNIQUE (tenant_id, package_id),
  CONSTRAINT ck_ceremony_completion_pair
    CHECK ((state = 'completed') = (completed_at IS NOT NULL AND completion_certificate_sha256 IS NOT NULL)),
  FOREIGN KEY (tenant_id, jacket_id) REFERENCES deal_jackets (tenant_id, jacket_id),
  FOREIGN KEY (tenant_id, package_id) REFERENCES jacket_packages (tenant_id, package_id),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);

CREATE TABLE ceremony_signers (
  signer_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  ceremony_id             UUID NOT NULL,
  signing_order           INTEGER NOT NULL CHECK (signing_order >= 1),
  signer_role             TEXT NOT NULL
                            CHECK (signer_role IN ('customer', 'co_buyer', 'dealer_representative')),
  lane                    TEXT NOT NULL CHECK (lane IN ('signer_token', 'staff_session')),
  party_id                UUID,
  user_link_id            UUID,
  display_name            TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  -- The channel the invitation goes to. Stored so the ceremony can be
  -- reconciled; never logged.
  contact_value           TEXT CHECK (contact_value IS NULL OR length(contact_value) <= 320),
  signing_authority       TEXT NOT NULL
                            CHECK (signing_authority IN ('self', 'authorised_representative')),
  token_sha256            TEXT UNIQUE CHECK (token_sha256 IS NULL OR token_sha256 ~ '^[0-9a-f]{64}$'),
  token_expires_at        TIMESTAMPTZ,
  identity_assurance      TEXT NOT NULL DEFAULT 'none'
                            CHECK (identity_assurance IN ('none', 'email_link', 'staff_session',
                                                          'knowledge_based_unavailable')),
  state                   TEXT NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending', 'invited', 'viewed', 'consented',
                                             'signed', 'declined', 'expired')),
  invited_at              TIMESTAMPTZ,
  viewed_at               TIMESTAMPTZ,
  consented_at            TIMESTAMPTZ,
  consent_text_version    TEXT CHECK (consent_text_version IS NULL OR length(consent_text_version) BETWEEN 1 AND 40),
  intent_confirmed_at     TIMESTAMPTZ,
  signed_at               TIMESTAMPTZ,
  -- sha256 over (bound package digest, signer id, role, signed_at, intent) in
  -- canonical form: the signature is a fact about exactly those bytes.
  signature_sha256        TEXT CHECK (signature_sha256 IS NULL OR signature_sha256 ~ '^[0-9a-f]{64}$'),
  declined_at             TIMESTAMPTZ,
  decline_reason          TEXT CHECK (decline_reason IS NULL OR length(decline_reason) <= 400),
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, signer_id),
  UNIQUE (tenant_id, ceremony_id, signing_order),
  CONSTRAINT ck_signer_lane_identity CHECK (
    (lane = 'signer_token' AND party_id IS NOT NULL AND user_link_id IS NULL)
    OR
    (lane = 'staff_session' AND user_link_id IS NOT NULL AND party_id IS NULL)
  ),
  -- A SIGNATURE IS FOUR INSTANTS IN ORDER, OR IT IS NOT ONE.
  CONSTRAINT ck_signer_signature_complete CHECK (
    signed_at IS NULL
    OR (consented_at IS NOT NULL AND intent_confirmed_at IS NOT NULL
        AND signature_sha256 IS NOT NULL
        AND consented_at <= intent_confirmed_at AND intent_confirmed_at <= signed_at)
  ),
  CONSTRAINT ck_signer_consent_names_version
    CHECK ((consented_at IS NULL) = (consent_text_version IS NULL)),
  CONSTRAINT ck_signer_decline_pair
    CHECK ((declined_at IS NULL) = (decline_reason IS NULL)),
  FOREIGN KEY (tenant_id, ceremony_id) REFERENCES signing_ceremonies (tenant_id, ceremony_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_ceremony_signers_ceremony ON ceremony_signers (tenant_id, ceremony_id, signing_order);

CREATE TABLE ceremony_events (
  event_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  ceremony_id             UUID NOT NULL,
  signer_id               UUID,
  event_type              TEXT NOT NULL CHECK (event_type ~ '^[a-z0-9_.]{2,60}$'),
  lane                    TEXT NOT NULL CHECK (lane IN ('staff', 'signer', 'provider', 'system')),
  actor_user_link_id      UUID,
  -- PII-SAFE by construction: ids, states, digests, instants. Never a name, an
  -- address or a contact value.
  payload                 JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_event_ref      TEXT CHECK (provider_event_ref IS NULL OR length(provider_event_ref) <= 200),
  provider_signature_valid BOOLEAN,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, event_id),
  -- A PROVIDER CALLBACK IS RECORDED ONCE. The second delivery converges here.
  UNIQUE (tenant_id, provider_event_ref),
  CONSTRAINT ck_event_provider_fields CHECK (
    (lane = 'provider' AND provider_event_ref IS NOT NULL AND provider_signature_valid IS NOT NULL)
    OR
    (lane <> 'provider' AND provider_event_ref IS NULL AND provider_signature_valid IS NULL)
  ),
  FOREIGN KEY (tenant_id, ceremony_id) REFERENCES signing_ceremonies (tenant_id, ceremony_id),
  FOREIGN KEY (tenant_id, signer_id) REFERENCES ceremony_signers (tenant_id, signer_id),
  FOREIGN KEY (tenant_id, actor_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_ceremony_events_ceremony ON ceremony_events (tenant_id, ceremony_id, occurred_at);

-- SHORT-LIVED ACCESS TO AN ARTIFACT, for a staff download or a signer's view.
-- The token is stored hashed; the grant names the document, the lane and the
-- identity it was issued to, and when it stops working — never more than
-- twenty-four hours out, by CHECK. Reads through it are counted.
CREATE TABLE artifact_access_grants (
  grant_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  document_id             UUID NOT NULL,
  issued_to_lane          TEXT NOT NULL CHECK (issued_to_lane IN ('staff', 'signer')),
  issued_to_user_link_id  UUID,
  issued_to_signer_id     UUID,
  token_sha256            TEXT NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  issued_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ NOT NULL,
  used_count              INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0),
  last_used_at            TIMESTAMPTZ,
  UNIQUE (tenant_id, grant_id),
  CONSTRAINT ck_grant_short_lived
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '24 hours'),
  CONSTRAINT ck_grant_lane_identity CHECK (
    (issued_to_lane = 'staff' AND issued_to_user_link_id IS NOT NULL AND issued_to_signer_id IS NULL)
    OR
    (issued_to_lane = 'signer' AND issued_to_signer_id IS NOT NULL AND issued_to_user_link_id IS NULL)
  ),
  FOREIGN KEY (tenant_id, document_id) REFERENCES package_documents (tenant_id, document_id),
  FOREIGN KEY (tenant_id, issued_to_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, issued_to_signer_id) REFERENCES ceremony_signers (tenant_id, signer_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 5 — LEGAL HOLD AS HISTORY
--
-- `package_documents.legal_hold` is the CURRENT answer; this table is how it
-- got there. A hold is placed and lifted by named people for stated reasons,
-- and a lifted hold does not erase the fact that it was placed.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE legal_hold_events (
  hold_event_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  jacket_id               UUID NOT NULL,
  action                  TEXT NOT NULL CHECK (action IN ('placed', 'lifted')),
  reason                  TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  reference               TEXT CHECK (reference IS NULL OR length(reference) <= 200),
  acted_by_user_link_id   UUID NOT NULL,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, hold_event_id),
  FOREIGN KEY (tenant_id, jacket_id) REFERENCES deal_jackets (tenant_id, jacket_id),
  FOREIGN KEY (tenant_id, acted_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 6 — GRANTS
--
-- The runtime may correct CURRENT state and may only ADD to history. DELETE is
-- granted to no table this phase adds: a signed document, a consent, a
-- provider event and a hold are all things that happened.
-- ────────────────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON
  deal_jackets, jacket_checklist_items, jacket_packages, package_documents,
  signing_ceremonies, ceremony_signers, artifact_access_grants
  TO dealership_runtime;

GRANT SELECT, INSERT ON
  document_templates, document_requirements, retention_policies,
  jacket_source_bindings, package_fields, document_blobs, ceremony_events, legal_hold_events
  TO dealership_runtime;

-- A CONFIGURED VERSION IS ENDED, NEVER EDITED. The one column the runtime may
-- move on a template, a requirement or a retention policy is `effective_to`:
-- recording the next version may close the one in force at the instant the
-- next one starts, so "end the one in force before starting the next" is a
-- single attributed act and the exclusion constraint still refuses any overlap.
-- The text, the source, the approval and the interval's start are written once.
GRANT UPDATE (effective_to) ON document_templates, document_requirements, retention_policies
  TO dealership_runtime;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 7 — THE RESOURCE REGISTRY
--
-- Three new rooftop-owned resources: a deal jacket, a package and a ceremony.
-- Everything hanging off them — bindings, checklist items, fields, documents,
-- signers, events, holds — is authorized THROUGH its parent. Templates,
-- requirements and retention policies are configuration written through
-- resource-less actions with a rooftop scope hint, for the same reason the
-- desking rule book is: a tenant-wide row has no rooftop to resolve to.
--
-- BOTH resolvers are re-declared and must stay in step, exactly as migration
-- 065 left them.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION resource_org_leaf(p_tenant uuid, p_type text, p_id uuid)
RETURNS uuid
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  leaf   uuid;
  tenant uuid;
BEGIN
  tenant := p_tenant;

  IF p_type = 'service_appointment' THEN
    SELECT t.location_id INTO leaf FROM service_appointments t
     WHERE t.tenant_id = tenant AND t.appointment_id = p_id;
  ELSIF p_type = 'repair_order' THEN
    SELECT t.location_id INTO leaf FROM repair_orders t
     WHERE t.tenant_id = tenant AND t.ro_id = p_id;
  ELSIF p_type = 'service_queue_item' THEN
    SELECT t.location_id INTO leaf FROM service_queue_items t
     WHERE t.tenant_id = tenant AND t.queue_item_id = p_id;
  ELSIF p_type = 'service_waitlist_entry' THEN
    SELECT t.location_id INTO leaf FROM service_waitlist_entries t
     WHERE t.tenant_id = tenant AND t.waitlist_entry_id = p_id;
  ELSIF p_type = 'mpi_session' THEN
    SELECT ro.location_id INTO leaf FROM mpi_sessions t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = tenant AND t.mpi_session_id = p_id;
  ELSIF p_type = 'ro_line_item' THEN
    SELECT ro.location_id INTO leaf FROM ro_line_items t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = tenant AND t.line_item_id = p_id;
  ELSIF p_type = 'ro_parts_line' THEN
    SELECT ro.location_id INTO leaf FROM ro_parts_lines t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = tenant AND t.part_line_id = p_id;
  ELSIF p_type = 'ro_sublet_job' THEN
    SELECT ro.location_id INTO leaf FROM ro_sublet_jobs t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = tenant AND t.sublet_job_id = p_id;
  ELSIF p_type = 'service_portal_task' THEN
    SELECT ro.location_id INTO leaf FROM service_portal_tasks t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = tenant AND t.portal_task_id = p_id;
  ELSIF p_type = 'tech_work_ticket' THEN
    SELECT ro.location_id INTO leaf FROM tech_work_tickets t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = tenant AND t.ticket_id = p_id;
  ELSIF p_type = 'warranty_claim' THEN
    SELECT ro.location_id INTO leaf FROM warranty_claims t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = tenant AND t.claim_id = p_id;
  ELSIF p_type = 'comeback_case' THEN
    SELECT ro.location_id INTO leaf FROM comeback_cases t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.original_ro_id
     WHERE t.tenant_id = tenant AND t.comeback_id = p_id;
  -- ── RELEASE TRAIN 2 ──────────────────────────────────────────────────────
  ELSIF p_type = 'stock_item' THEN
    SELECT t.rooftop_id INTO leaf FROM stock_items t
     WHERE t.tenant_id = tenant AND t.stock_item_id = p_id;
  ELSIF p_type = 'stock_listing' THEN
    SELECT si.rooftop_id INTO leaf FROM stock_listings t
      JOIN stock_items si ON si.tenant_id = t.tenant_id AND si.stock_item_id = t.stock_item_id
     WHERE t.tenant_id = tenant AND t.listing_id = p_id;
  -- ── RELEASE TRAIN 3 ──────────────────────────────────────────────────────
  ELSIF p_type = 'lead' THEN
    SELECT t.rooftop_id INTO leaf FROM leads t
     WHERE t.tenant_id = tenant AND t.lead_id = p_id;
  ELSIF p_type = 'appointment' THEN
    SELECT t.rooftop_id INTO leaf FROM appointments t
     WHERE t.tenant_id = tenant AND t.appointment_id = p_id;
  ELSIF p_type = 'campaign' THEN
    SELECT t.rooftop_id INTO leaf FROM campaigns t
     WHERE t.tenant_id = tenant AND t.campaign_id = p_id;
  -- ── RELEASE TRAIN 4 ──────────────────────────────────────────────────────
  ELSIF p_type = 'opportunity' THEN
    SELECT t.rooftop_id INTO leaf FROM opportunities t
     WHERE t.tenant_id = tenant AND t.opportunity_id = p_id;
  ELSIF p_type = 'showroom_visit' THEN
    SELECT t.rooftop_id INTO leaf FROM showroom_visits t
     WHERE t.tenant_id = tenant AND t.visit_id = p_id;
  ELSIF p_type = 'demonstration' THEN
    SELECT t.rooftop_id INTO leaf FROM demonstrations t
     WHERE t.tenant_id = tenant AND t.demonstration_id = p_id;
  -- ── FBL-120 ──────────────────────────────────────────────────────────────
  ELSIF p_type = 'desking_case' THEN
    SELECT t.rooftop_id INTO leaf FROM desking_cases t
     WHERE t.tenant_id = tenant AND t.desking_case_id = p_id;
  ELSIF p_type = 'appraisal' THEN
    SELECT t.rooftop_id INTO leaf FROM appraisals t
     WHERE t.tenant_id = tenant AND t.appraisal_id = p_id;
  ELSIF p_type = 'desking_scenario' THEN
    SELECT t.rooftop_id INTO leaf FROM desking_scenarios t
     WHERE t.tenant_id = tenant AND t.scenario_id = p_id;
  -- ── FBL-140 ──────────────────────────────────────────────────────────────
  ELSIF p_type = 'deal_jacket' THEN
    SELECT t.rooftop_id INTO leaf FROM deal_jackets t
     WHERE t.tenant_id = tenant AND t.jacket_id = p_id;
  ELSIF p_type = 'jacket_package' THEN
    SELECT t.rooftop_id INTO leaf FROM jacket_packages t
     WHERE t.tenant_id = tenant AND t.package_id = p_id;
  ELSIF p_type = 'signing_ceremony' THEN
    SELECT t.rooftop_id INTO leaf FROM signing_ceremonies t
     WHERE t.tenant_id = tenant AND t.ceremony_id = p_id;
  END IF;
  RETURN leaf;
END;
$$ LANGUAGE plpgsql STABLE;

REVOKE ALL ON FUNCTION resource_org_leaf(uuid, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resource_org_leaf(uuid, text, uuid) TO dealership_evidence_owner;

CREATE OR REPLACE FUNCTION resource_org_leaf_visible(p_type text, p_id uuid)
RETURNS uuid
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE leaf uuid;
BEGIN
  IF p_type = 'service_appointment' THEN
    SELECT t.location_id INTO leaf FROM service_appointments t
     WHERE t.tenant_id = app_tenant_ctx() AND t.appointment_id = p_id;
  ELSIF p_type = 'repair_order' THEN
    SELECT t.location_id INTO leaf FROM repair_orders t
     WHERE t.tenant_id = app_tenant_ctx() AND t.ro_id = p_id;
  ELSIF p_type = 'service_queue_item' THEN
    SELECT t.location_id INTO leaf FROM service_queue_items t
     WHERE t.tenant_id = app_tenant_ctx() AND t.queue_item_id = p_id;
  ELSIF p_type = 'service_waitlist_entry' THEN
    SELECT t.location_id INTO leaf FROM service_waitlist_entries t
     WHERE t.tenant_id = app_tenant_ctx() AND t.waitlist_entry_id = p_id;
  ELSIF p_type = 'mpi_session' THEN
    SELECT ro.location_id INTO leaf FROM mpi_sessions t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = app_tenant_ctx() AND t.mpi_session_id = p_id;
  ELSIF p_type = 'ro_line_item' THEN
    SELECT ro.location_id INTO leaf FROM ro_line_items t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = app_tenant_ctx() AND t.line_item_id = p_id;
  ELSIF p_type = 'ro_parts_line' THEN
    SELECT ro.location_id INTO leaf FROM ro_parts_lines t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = app_tenant_ctx() AND t.part_line_id = p_id;
  ELSIF p_type = 'ro_sublet_job' THEN
    SELECT ro.location_id INTO leaf FROM ro_sublet_jobs t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = app_tenant_ctx() AND t.sublet_job_id = p_id;
  ELSIF p_type = 'service_portal_task' THEN
    SELECT ro.location_id INTO leaf FROM service_portal_tasks t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = app_tenant_ctx() AND t.portal_task_id = p_id;
  ELSIF p_type = 'tech_work_ticket' THEN
    SELECT ro.location_id INTO leaf FROM tech_work_tickets t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = app_tenant_ctx() AND t.ticket_id = p_id;
  ELSIF p_type = 'warranty_claim' THEN
    SELECT ro.location_id INTO leaf FROM warranty_claims t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = app_tenant_ctx() AND t.claim_id = p_id;
  ELSIF p_type = 'comeback_case' THEN
    SELECT ro.location_id INTO leaf FROM comeback_cases t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.original_ro_id
     WHERE t.tenant_id = app_tenant_ctx() AND t.comeback_id = p_id;
  -- ── RELEASE TRAIN 2 — row security is the predicate ──────────────────────
  ELSIF p_type = 'stock_item' THEN
    SELECT t.rooftop_id INTO leaf FROM stock_items t
     WHERE t.stock_item_id = p_id;
  ELSIF p_type = 'stock_listing' THEN
    SELECT si.rooftop_id INTO leaf FROM stock_listings t
      JOIN stock_items si ON si.tenant_id = t.tenant_id AND si.stock_item_id = t.stock_item_id
     WHERE t.listing_id = p_id;
  -- ── RELEASE TRAIN 3 — row security is the predicate ──────────────────────
  ELSIF p_type = 'lead' THEN
    SELECT t.rooftop_id INTO leaf FROM leads t
     WHERE t.lead_id = p_id;
  ELSIF p_type = 'appointment' THEN
    SELECT t.rooftop_id INTO leaf FROM appointments t
     WHERE t.appointment_id = p_id;
  ELSIF p_type = 'campaign' THEN
    SELECT t.rooftop_id INTO leaf FROM campaigns t
     WHERE t.campaign_id = p_id;
  -- ── RELEASE TRAIN 4 — row security is the predicate ──────────────────────
  ELSIF p_type = 'opportunity' THEN
    SELECT t.rooftop_id INTO leaf FROM opportunities t
     WHERE t.opportunity_id = p_id;
  ELSIF p_type = 'showroom_visit' THEN
    SELECT t.rooftop_id INTO leaf FROM showroom_visits t
     WHERE t.visit_id = p_id;
  ELSIF p_type = 'demonstration' THEN
    SELECT t.rooftop_id INTO leaf FROM demonstrations t
     WHERE t.demonstration_id = p_id;
  -- ── FBL-120 — row security is the predicate ──────────────────────────────
  ELSIF p_type = 'desking_case' THEN
    SELECT t.rooftop_id INTO leaf FROM desking_cases t
     WHERE t.desking_case_id = p_id;
  ELSIF p_type = 'appraisal' THEN
    SELECT t.rooftop_id INTO leaf FROM appraisals t
     WHERE t.appraisal_id = p_id;
  ELSIF p_type = 'desking_scenario' THEN
    SELECT t.rooftop_id INTO leaf FROM desking_scenarios t
     WHERE t.scenario_id = p_id;
  -- ── FBL-140 — row security is the predicate ──────────────────────────────
  ELSIF p_type = 'deal_jacket' THEN
    SELECT t.rooftop_id INTO leaf FROM deal_jackets t
     WHERE t.jacket_id = p_id;
  ELSIF p_type = 'jacket_package' THEN
    SELECT t.rooftop_id INTO leaf FROM jacket_packages t
     WHERE t.package_id = p_id;
  ELSIF p_type = 'signing_ceremony' THEN
    SELECT t.rooftop_id INTO leaf FROM signing_ceremonies t
     WHERE t.ceremony_id = p_id;
  END IF;
  RETURN leaf;
END;
$$ LANGUAGE plpgsql STABLE;

REVOKE ALL ON FUNCTION resource_org_leaf_visible(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resource_org_leaf_visible(text, uuid) TO dealership_runtime;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 8 — DENY-BY-DEFAULT ROW SECURITY
--
-- `document_blobs` is the one table without a tenant column: it is keyed by
-- content and holds no tenant fact of its own. Every ROUTE to a blob runs
-- through `package_documents`, which IS tenant-secured, and the runtime may only
-- INSERT and SELECT it. It is row-secured too — with a policy that admits the
-- runtime's reads and writes — so that the census of secured tables holds every
-- table this phase adds without exception.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE document_templates       ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_requirements    ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policies       ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_jackets             ENABLE ROW LEVEL SECURITY;
ALTER TABLE jacket_source_bindings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE jacket_checklist_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE jacket_packages          ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_fields           ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_blobs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE package_documents        ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_access_grants   ENABLE ROW LEVEL SECURITY;
ALTER TABLE signing_ceremonies       ENABLE ROW LEVEL SECURITY;
ALTER TABLE ceremony_signers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE ceremony_events          ENABLE ROW LEVEL SECURITY;
ALTER TABLE legal_hold_events        ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_document_templates_tenant ON document_templates
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_document_requirements_tenant ON document_requirements
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_retention_policies_tenant ON retention_policies
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_deal_jackets_tenant ON deal_jackets
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_jacket_source_bindings_tenant ON jacket_source_bindings
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_jacket_checklist_items_tenant ON jacket_checklist_items
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_jacket_packages_tenant ON jacket_packages
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_package_fields_tenant ON package_fields
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
-- Content-addressed and tenantless; reachable only through package_documents.
CREATE POLICY rls_document_blobs_runtime ON document_blobs
  FOR ALL TO dealership_runtime
  USING (app_tenant_ctx() IS NOT NULL) WITH CHECK (app_tenant_ctx() IS NOT NULL);
CREATE POLICY rls_package_documents_tenant ON package_documents
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_artifact_access_grants_tenant ON artifact_access_grants
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_signing_ceremonies_tenant ON signing_ceremonies
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_ceremony_signers_tenant ON ceremony_signers
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_ceremony_events_tenant ON ceremony_events
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_legal_hold_events_tenant ON legal_hold_events
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());

-- ────────────────────────────────────────────────────────────────────────────
-- Section 9 — THE TRIGGERS THAT FREEZE A RENDERED OR SIGNED PACKAGE
-- ────────────────────────────────────────────────────────────────────────────

-- (a) A BLOB IS ITS OWN DIGEST. The key is recomputed from the bytes on insert,
--     so a row that names one hash and holds other bytes cannot exist, and the
--     row cannot change afterwards because nothing may UPDATE or DELETE it.
CREATE OR REPLACE FUNCTION document_blobs_are_content_addressed()
RETURNS trigger
SET search_path = public, pg_temp
AS $$
DECLARE computed text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION
      'document_blobs % refused: a rendered artifact is content-addressed and immutable', TG_OP;
  END IF;
  computed := encode(digest(NEW.content, 'sha256'), 'hex');
  IF computed <> NEW.content_sha256 THEN
    RAISE EXCEPTION
      'document_blobs INSERT refused: the row names digest % but its bytes digest to % — a '
      'key that lies about its content is the one thing a content-addressed store must refuse',
      NEW.content_sha256, computed;
  END IF;
  IF NEW.byte_size <> octet_length(NEW.content) THEN
    RAISE EXCEPTION
      'document_blobs INSERT refused: byte_size % does not match % bytes of content',
      NEW.byte_size, octet_length(NEW.content);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_document_blobs_content_addressed
  BEFORE INSERT OR UPDATE OR DELETE ON document_blobs
  FOR EACH ROW EXECUTE FUNCTION document_blobs_are_content_addressed();

-- (b) A PACKAGE'S FIELDS AND DIGESTS ARE WRITTEN ONCE. `state`, the review
--     stamp, the state reason and the housekeeping columns may move; nothing
--     that a signer could have read may. Terminal states are absorbing, except
--     that a completed package may be superseded by a later version.
CREATE OR REPLACE FUNCTION jacket_packages_freeze()
RETURNS trigger
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.package_id <> OLD.package_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.jacket_id <> OLD.jacket_id
     OR NEW.rooftop_id <> OLD.rooftop_id
     OR NEW.version_no <> OLD.version_no
     OR NEW.supersedes_package_id IS DISTINCT FROM OLD.supersedes_package_id
     OR NEW.fields_sha256 <> OLD.fields_sha256
     OR NEW.assembled_by_user_link_id <> OLD.assembled_by_user_link_id
     OR NEW.assembled_at <> OLD.assembled_at
     OR NEW.carries_unapproved_templates <> OLD.carries_unapproved_templates
  THEN
    RAISE EXCEPTION
      'jacket_packages UPDATE refused: version % of jacket % is a written version, and its '
      'fields, digests and provenance cannot be edited — assemble the next version, which '
      'supersedes this one and leaves what was rendered and signed intact',
      OLD.version_no, OLD.jacket_id;
  END IF;
  -- The package digest is set exactly once, when rendering completes.
  IF OLD.package_sha256 IS NOT NULL AND NEW.package_sha256 IS DISTINCT FROM OLD.package_sha256 THEN
    RAISE EXCEPTION
      'jacket_packages UPDATE refused: the package digest of version % is set once, when it is '
      'rendered, and a ceremony may already have bound to it',
      OLD.version_no;
  END IF;
  IF OLD.document_count > 0 AND NEW.document_count <> OLD.document_count THEN
    RAISE EXCEPTION
      'jacket_packages UPDATE refused: a rendered package does not gain or lose documents';
  END IF;
  -- Once sent, the review stamp is history too.
  IF OLD.state NOT IN ('draft', 'review_ready')
     AND (NEW.reviewed_by_user_link_id IS DISTINCT FROM OLD.reviewed_by_user_link_id
          OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at) THEN
    RAISE EXCEPTION
      'jacket_packages UPDATE refused: the review of a sent package cannot be rewritten';
  END IF;
  IF OLD.state = 'signed_complete' AND NEW.state NOT IN ('signed_complete', 'superseded') THEN
    RAISE EXCEPTION
      'jacket_packages UPDATE refused: a signed package may only be superseded, not moved to %',
      NEW.state;
  END IF;
  IF OLD.state IN ('voided', 'expired', 'superseded') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION
      'jacket_packages UPDATE refused: % is a final state and % is not reachable from it',
      OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_jacket_packages_freeze
  BEFORE UPDATE ON jacket_packages
  FOR EACH ROW EXECUTE FUNCTION jacket_packages_freeze();

-- (c) A RENDERED DOCUMENT IS EVIDENCE. Two facts about it may change after
--     the fact — a malware scan may complete, a legal hold may be placed or
--     lifted — and nothing else may.
CREATE OR REPLACE FUNCTION package_documents_freeze()
RETURNS trigger
SET search_path = public, pg_temp
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'package_documents DELETE refused: a rendered document is evidence';
  END IF;
  IF NEW.document_id <> OLD.document_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.package_id <> OLD.package_id
     OR NEW.sequence_no <> OLD.sequence_no
     OR NEW.document_kind <> OLD.document_kind
     OR NEW.title <> OLD.title
     OR NEW.template_id IS DISTINCT FROM OLD.template_id
     OR NEW.template_version IS DISTINCT FROM OLD.template_version
     OR NEW.template_sha256 IS DISTINCT FROM OLD.template_sha256
     OR NEW.template_approval_status IS DISTINCT FROM OLD.template_approval_status
     OR NEW.content_sha256 <> OLD.content_sha256
     OR NEW.mime_type <> OLD.mime_type
     OR NEW.byte_size <> OLD.byte_size
     OR NEW.classification <> OLD.classification
     OR NEW.retention_policy_id <> OLD.retention_policy_id
     OR NEW.rendered_at <> OLD.rendered_at
  THEN
    RAISE EXCEPTION
      'package_documents UPDATE refused: document % is rendered evidence — only its scan result '
      'and its legal-hold state may change, and a changed input is a new package version',
      OLD.document_id;
  END IF;
  IF OLD.malware_scan_result <> 'not_scanned' AND NEW.malware_scan_result <> OLD.malware_scan_result THEN
    RAISE EXCEPTION
      'package_documents UPDATE refused: a recorded scan result is not re-decided';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_package_documents_freeze
  BEFORE UPDATE OR DELETE ON package_documents
  FOR EACH ROW EXECUTE FUNCTION package_documents_freeze();

-- (d) A SIGNATURE BINDS THE EXACT PACKAGE, IN A SIGNABLE STATE, AFTER CONSENT.
--     The refusal here is what "a signer cannot sign a superseded or modified
--     package" means in the database: the package's digest must equal the
--     digest the ceremony bound to, its state must still admit signatures, and
--     a signature once written is never rewritten.
CREATE OR REPLACE FUNCTION ceremony_signers_bind_signature()
RETURNS trigger
SET search_path = public, pg_temp
AS $$
DECLARE
  c RECORD;
  p RECORD;
BEGIN
  IF OLD.signed_at IS NOT NULL
     AND (NEW.signed_at IS DISTINCT FROM OLD.signed_at
          OR NEW.signature_sha256 IS DISTINCT FROM OLD.signature_sha256
          OR NEW.consented_at IS DISTINCT FROM OLD.consented_at
          OR NEW.intent_confirmed_at IS DISTINCT FROM OLD.intent_confirmed_at) THEN
    RAISE EXCEPTION
      'ceremony_signers UPDATE refused: signer % has signed, and a signature is not rewritten',
      OLD.signer_id;
  END IF;
  IF NEW.signer_role <> OLD.signer_role OR NEW.lane <> OLD.lane
     OR NEW.party_id IS DISTINCT FROM OLD.party_id OR NEW.user_link_id IS DISTINCT FROM OLD.user_link_id
     OR NEW.ceremony_id <> OLD.ceremony_id THEN
    RAISE EXCEPTION
      'ceremony_signers UPDATE refused: who a signer is, and which lane they sign through, '
      'is fixed when the ceremony is created';
  END IF;
  IF NEW.signed_at IS NOT NULL AND OLD.signed_at IS NULL THEN
    SELECT s.bound_package_sha256, s.state, s.package_id INTO c
      FROM signing_ceremonies s
     WHERE s.tenant_id = NEW.tenant_id AND s.ceremony_id = NEW.ceremony_id;
    IF c.state NOT IN ('sent', 'in_progress') THEN
      RAISE EXCEPTION
        'ceremony_signers UPDATE refused: ceremony % is %, and % does not admit signatures',
        NEW.ceremony_id, c.state, c.state;
    END IF;
    SELECT k.package_sha256, k.state INTO p
      FROM jacket_packages k
     WHERE k.tenant_id = NEW.tenant_id AND k.package_id = c.package_id;
    IF p.package_sha256 IS DISTINCT FROM c.bound_package_sha256 THEN
      RAISE EXCEPTION
        'ceremony_signers UPDATE refused: the ceremony bound package digest % and the package '
        'now carries % — a signature binds exactly the bytes the signer read',
        c.bound_package_sha256, p.package_sha256;
    END IF;
    IF p.state NOT IN ('sent', 'partially_signed') THEN
      RAISE EXCEPTION
        'ceremony_signers UPDATE refused: package is % and cannot be signed — a superseded, voided, '
        'expired or unsent package takes no signature',
        p.state;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ceremony_signers_bind_signature
  BEFORE UPDATE ON ceremony_signers
  FOR EACH ROW EXECUTE FUNCTION ceremony_signers_bind_signature();

-- (e) LEDGERS ARE APPEND-ONLY. The runtime holds no UPDATE or DELETE on any of
--     these; the trigger refuses them for every other role as well.
CREATE OR REPLACE FUNCTION fbl140_ledger_append_only()
RETURNS trigger
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    '% % refused: this is an append-only ledger — record the next fact rather than rewriting one',
    TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ceremony_events_append_only
  BEFORE UPDATE OR DELETE ON ceremony_events
  FOR EACH ROW EXECUTE FUNCTION fbl140_ledger_append_only();
CREATE TRIGGER trg_package_fields_append_only
  BEFORE UPDATE OR DELETE ON package_fields
  FOR EACH ROW EXECUTE FUNCTION fbl140_ledger_append_only();
CREATE TRIGGER trg_jacket_source_bindings_append_only
  BEFORE UPDATE OR DELETE ON jacket_source_bindings
  FOR EACH ROW EXECUTE FUNCTION fbl140_ledger_append_only();
CREATE TRIGGER trg_legal_hold_events_append_only
  BEFORE UPDATE OR DELETE ON legal_hold_events
  FOR EACH ROW EXECUTE FUNCTION fbl140_ledger_append_only();
