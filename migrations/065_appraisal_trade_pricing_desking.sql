-- ============================================================================
-- FBL-120 — APPRAISAL, TRADE, PRICING AND DESKING
--
-- One phase over the immutable 000–064 chain. It begins where Release Train 4
-- stopped: `desking_handoffs` is the seam, and a desking case is created FROM
-- one rather than beside it, so a desk file cannot start from thin air.
--
--   1. THE DESKING CASE — the RT4 fact consumed exactly once, carrying the
--      canonical opportunity, customer, rooftop and selected vehicle.
--   2. THE APPRAISAL — the trade unit's identity, and versioned, attributable
--      evidence about it: ownership, odometer, condition, equipment, damage,
--      observations, attachments and source quotations.
--   3. THE RULE BOOK — every tax, fee, incentive, valuation and policy input,
--      each naming its source, its jurisdiction or rooftop scope, its effective
--      interval and its version, and none of them overlapping.
--   4. THE SCENARIOS — deterministic, versioned figures computed from explicit
--      inputs, with the rules they were computed under recorded beside them.
--   5. APPROVAL AND FREEZE — an attributable manager decision bound to the
--      exact version reviewed, and history that cannot be rewritten.
--   6. THE RT4 SEAM, RELAXED — `desking_status` may finally say AVAILABLE.
--   7. THE GRANTS the runtime role needs.
--   8. THE RESOURCE REGISTRY — both resolvers re-declared.
--   9. DENY-BY-DEFAULT ROW SECURITY over every table this phase adds.
--  10. THE TRIGGERS that make an approved version immutable in the database
--      rather than merely in the service that writes it.
--
-- MONEY, AT LAST — AND IN INTEGER MINOR UNITS. Release Train 4 carried no money
-- column anywhere and said so; this phase is where the figures arrive. They
-- arrive as `*_cents BIGINT`, exactly as migration 062's `stock_prices` does,
-- because Row 3 requires identical inputs to reproduce identical outputs and a
-- binary float cannot promise that. Rates are `*_ppm BIGINT` — parts per
-- million, so 6.5% is 65000 — for the same reason. There is no DOUBLE
-- PRECISION and no NUMERIC-with-arithmetic anywhere in this migration.
--
-- WHAT THIS PHASE DELIBERATELY DOES NOT DO, so the omissions read as decisions:
--
--   * NO SALE, NO CONTRACT, NO FUNDED DEAL, NO DELIVERY, NO SOLD VEHICLE. The
--     phase ends at an immutable approved scenario version that is READY for
--     the deal-jacket phase. There is no `deals` table here, no `sales` table,
--     no delivery, and nothing in this migration writes to inventory.
--   * NO DIGITAL RETAIL, DEAL JACKET, E-SIGN, CREDIT APPLICATION, UNDERWRITING,
--     LENDER DECISION, PAYMENT, FUNDING, TITLE OR REGISTRATION. Those are
--     FBL-130 through FBL-160 and the exclusion list of Version 3.1 §14.3 Part B
--     names every one of them.
--   * NO AUTHORITATIVE REVENUE. Migration 063's `ck_attribution_pre_sale_revenue`
--     STAYS AS IT IS. Migration 064's header guessed that whoever wrote this
--     migration would relax it; that guess was wrong, and saying so is cheaper
--     than honouring it. A desking scenario is a PRICED PROPOSAL a manager has
--     approved — it is not a sale, no money has moved, and attribution revenue
--     recorded from it would be a forecast wearing an accounting record's
--     clothes. The constraint is relaxed by whoever builds FBL-160, when funds
--     actually move.
--   * NO FINANCE BEYOND DESKING. A term and a rate are carried because a desk
--     manager compares monthly figures; there is no amortisation schedule, no
--     lender, no credit tier and no approval from anyone but the desk.
-- ============================================================================

-- The exclusion constraint in section 3 needs GiST over scalar types. It is the
-- only new extension this chain has taken since pgcrypto, and it earns its keep:
-- "overlapping rules refuse" becomes a fact of the database rather than a
-- promise made by the service that happens to be writing today.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 1 — THE DESKING CASE
--
-- Release Train 4 ends by writing ONE `desking_handoffs` row per opportunity,
-- whose (tenant_id, opportunity_id) unique key is its exactly-once guarantee,
-- and ONE outbox event in the same transaction. This phase consumes that fact.
--
-- CONSUMED EXACTLY ONCE, AND THE DATABASE IS WHAT SAYS SO. Two unique keys, not
-- one: a case is unique per opportunity AND unique per handoff. The first makes
-- "one desk file per customer conversation" true; the second makes a replayed
-- outbox delivery — which is at-least-once by design — converge on the case it
-- already opened rather than opening a second one beside it.
--
-- WHAT IS CARRIED, AND WHY IT IS COPIED RATHER THAN JOINED. The rooftop, the
-- party and the selected stock item are copied from the fact at intake. A join
-- would answer "what does the opportunity say NOW", and desking has to answer
-- "what was handed to the desk" — those diverge the moment anything upstream
-- moves, and the desk's answer is the one a manager approved against.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE desking_cases (
  desking_case_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rooftop_id              UUID NOT NULL,
  opportunity_id          UUID NOT NULL,
  party_id                UUID NOT NULL,
  -- The car they committed to, when one was settled on the floor. Optional for
  -- the same reason RT4's fact carries it as optional.
  stock_item_id           UUID,
  -- The fact this case consumed, and the outbox event that delivered it.
  desking_handoff_id      UUID NOT NULL,
  intake_outbox_event_id  UUID,
  state                   TEXT NOT NULL DEFAULT 'open'
                            CHECK (state IN ('open', 'approved')),
  opened_by_user_link_id  UUID NOT NULL,
  approved_at             TIMESTAMPTZ,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, desking_case_id),
  -- EXACTLY ONE PER OPPORTUNITY, AND EXACTLY ONE PER FACT.
  UNIQUE (tenant_id, opportunity_id),
  UNIQUE (tenant_id, desking_handoff_id),
  CONSTRAINT ck_desking_case_approved_stamped
    CHECK ((state = 'approved') = (approved_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, opportunity_id),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, desking_handoff_id)
    REFERENCES desking_handoffs (tenant_id, desking_handoff_id),
  FOREIGN KEY (tenant_id, opened_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_desking_cases_rooftop ON desking_cases (tenant_id, rooftop_id, state, created_at);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 2 — THE APPRAISAL
--
-- IDENTITY IS ONE ROW; EVIDENCE IS MANY VERSIONS. The trade unit's VIN, year,
-- make, model and trim do not change — if they do, it is a different car and a
-- different appraisal. Everything a walk-around discovers DOES change, twice
-- before lunch, and each change is a version with a recorder and a reason.
--
-- ONE TRADE PER CASE. `UNIQUE (tenant_id, desking_case_id)` because Version 3.1
-- §14.3 Part B says "optional trade vehicle", singular. A second trade would be
-- a scenario input this phase has not been asked for, and inventing a table for
-- it would be inventing scope.
--
-- WHAT MAKES A QUOTATION HONEST. `appraisal_source_quotations` is where an
-- outside valuation lands, and its CHECK is the whole of Row 2's "unavailable
-- external valuation data is explicit rather than fabricated": a row that says
-- NOT_YET_AVAILABLE cannot also carry a number, and a row that carries a number
-- must say when it was quoted and in what currency. A deterministic simulator
-- may stand in for an uncertified provider — `provider_kind` says which it was,
-- so nothing here pretends to be live data.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE appraisals (
  appraisal_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rooftop_id              UUID NOT NULL,
  desking_case_id         UUID NOT NULL,
  vin                     TEXT NOT NULL CHECK (vin ~ '^[A-HJ-NPR-Z0-9]{11,17}$'),
  model_year              INTEGER NOT NULL CHECK (model_year BETWEEN 1900 AND 2100),
  make                    TEXT NOT NULL CHECK (length(make) BETWEEN 1 AND 60),
  model                   TEXT NOT NULL CHECK (length(model) BETWEEN 1 AND 60),
  trim_level              TEXT CHECK (trim_level IS NULL OR length(trim_level) <= 60),
  current_version_no      INTEGER NOT NULL DEFAULT 1 CHECK (current_version_no >= 1),
  created_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, appraisal_id),
  UNIQUE (tenant_id, desking_case_id),
  FOREIGN KEY (tenant_id, desking_case_id) REFERENCES desking_cases (tenant_id, desking_case_id),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);

CREATE TABLE appraisal_versions (
  appraisal_version_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  appraisal_id            UUID NOT NULL,
  version_no              INTEGER NOT NULL CHECK (version_no >= 1),
  ownership               TEXT NOT NULL
                            CHECK (ownership IN ('owned_outright', 'financed', 'leased')),
  relationship            TEXT NOT NULL
                            CHECK (relationship IN ('customer_owned', 'co_owned', 'third_party')),
  odometer_miles          INTEGER NOT NULL CHECK (odometer_miles >= 0),
  odometer_status         TEXT NOT NULL
                            CHECK (odometer_status IN ('actual', 'not_actual', 'exceeds_limits')),
  condition_grade         TEXT NOT NULL
                            CHECK (condition_grade IN ('rough', 'average', 'clean', 'extra_clean')),
  -- What the desk was told, and who says so. A version that cannot say where
  -- its facts came from is a rumour with a timestamp.
  provenance              TEXT NOT NULL
                            CHECK (provenance IN ('walk_around', 'third_party_inspection',
                                                  'customer_declared')),
  inspection_notes        TEXT CHECK (inspection_notes IS NULL OR length(inspection_notes) <= 2000),
  change_reason           TEXT CHECK (change_reason IS NULL OR length(change_reason) <= 400),
  recorded_by_user_link_id UUID NOT NULL,
  recorded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, appraisal_version_id),
  UNIQUE (tenant_id, appraisal_id, version_no),
  FOREIGN KEY (tenant_id, appraisal_id) REFERENCES appraisals (tenant_id, appraisal_id),
  FOREIGN KEY (tenant_id, recorded_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_appraisal_versions_appraisal
  ON appraisal_versions (tenant_id, appraisal_id, version_no DESC);

CREATE TABLE appraisal_damage_items (
  damage_item_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  appraisal_version_id    UUID NOT NULL,
  area                    TEXT NOT NULL CHECK (length(area) BETWEEN 1 AND 60),
  severity                TEXT NOT NULL CHECK (severity IN ('light', 'moderate', 'severe')),
  note                    TEXT CHECK (note IS NULL OR length(note) <= 400),
  estimated_repair_cents  BIGINT CHECK (estimated_repair_cents IS NULL OR estimated_repair_cents >= 0),
  currency                TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  UNIQUE (tenant_id, damage_item_id),
  FOREIGN KEY (tenant_id, appraisal_version_id)
    REFERENCES appraisal_versions (tenant_id, appraisal_version_id)
);
CREATE INDEX idx_appraisal_damage_version
  ON appraisal_damage_items (tenant_id, appraisal_version_id);

CREATE TABLE appraisal_equipment (
  equipment_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  appraisal_version_id    UUID NOT NULL,
  code                    TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  label                   TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  present                 BOOLEAN NOT NULL,
  UNIQUE (tenant_id, equipment_id),
  UNIQUE (tenant_id, appraisal_version_id, code),
  FOREIGN KEY (tenant_id, appraisal_version_id)
    REFERENCES appraisal_versions (tenant_id, appraisal_version_id)
);

CREATE TABLE appraisal_observations (
  observation_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  appraisal_version_id    UUID NOT NULL,
  observation             TEXT NOT NULL CHECK (length(observation) BETWEEN 1 AND 1000),
  observed_by_user_link_id UUID NOT NULL,
  observed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, observation_id),
  FOREIGN KEY (tenant_id, appraisal_version_id)
    REFERENCES appraisal_versions (tenant_id, appraisal_version_id),
  FOREIGN KEY (tenant_id, observed_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_appraisal_observations_version
  ON appraisal_observations (tenant_id, appraisal_version_id, observed_at);

-- Attachments and quotations hang off the APPRAISAL rather than one version,
-- and record which version they arrived in. A photograph taken once should not
-- have to be taken again because the odometer was corrected.
CREATE TABLE appraisal_attachments (
  attachment_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  appraisal_id            UUID NOT NULL,
  added_in_version_no     INTEGER NOT NULL CHECK (added_in_version_no >= 1),
  kind                    TEXT NOT NULL CHECK (kind IN ('photo', 'document', 'report')),
  label                   TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  uri                     TEXT NOT NULL CHECK (length(uri) BETWEEN 1 AND 500),
  content_sha256          TEXT CHECK (content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
  added_by_user_link_id   UUID NOT NULL,
  added_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, attachment_id),
  FOREIGN KEY (tenant_id, appraisal_id) REFERENCES appraisals (tenant_id, appraisal_id),
  FOREIGN KEY (tenant_id, added_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_appraisal_attachments_appraisal
  ON appraisal_attachments (tenant_id, appraisal_id, added_at);

CREATE TABLE appraisal_source_quotations (
  quotation_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  appraisal_id            UUID NOT NULL,
  added_in_version_no     INTEGER NOT NULL CHECK (added_in_version_no >= 1),
  provider_code           TEXT NOT NULL CHECK (length(provider_code) BETWEEN 1 AND 40),
  provider_kind           TEXT NOT NULL
                            CHECK (provider_kind IN ('deterministic_simulator', 'certified_provider')),
  availability            TEXT NOT NULL
                            CHECK (availability IN ('quoted', 'NOT_YET_AVAILABLE')),
  quoted_value_cents      BIGINT CHECK (quoted_value_cents IS NULL OR quoted_value_cents >= 0),
  currency                TEXT CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
  quoted_at               TIMESTAMPTZ,
  reference               TEXT CHECK (reference IS NULL OR length(reference) <= 200),
  unavailable_reason      TEXT CHECK (unavailable_reason IS NULL OR length(unavailable_reason) <= 400),
  recorded_by_user_link_id UUID NOT NULL,
  recorded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, quotation_id),
  -- A NUMBER OR AN ABSENCE, NEVER BOTH AND NEVER NEITHER.
  CONSTRAINT ck_quotation_value_iff_quoted CHECK (
    (availability = 'quoted'
       AND quoted_value_cents IS NOT NULL AND currency IS NOT NULL AND quoted_at IS NOT NULL)
    OR
    (availability = 'NOT_YET_AVAILABLE'
       AND quoted_value_cents IS NULL AND currency IS NULL AND quoted_at IS NULL
       AND unavailable_reason IS NOT NULL)
  ),
  FOREIGN KEY (tenant_id, appraisal_id) REFERENCES appraisals (tenant_id, appraisal_id),
  FOREIGN KEY (tenant_id, recorded_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_appraisal_quotations_appraisal
  ON appraisal_source_quotations (tenant_id, appraisal_id, recorded_at);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 3 — THE RULE BOOK
--
-- Row 4 of the order: every tax, fee, incentive, valuation and policy input
-- names its source, its jurisdiction or rooftop scope, its effective interval
-- and its version. This is that table, and the constraint under it is what
-- turns the sentence into a guarantee.
--
-- WHY ONE TABLE RATHER THAN FIVE. A scenario resolves ALL of its inputs the
-- same way — kind, code, scope, instant — and five tables would mean five
-- resolvers that could drift apart. `rule_kind` is the discriminator, and the
-- CHECK on `basis` is what keeps a percentage rule from carrying a flat amount.
--
-- THE EXCLUSION CONSTRAINT IS THE POINT. Two rules with the same kind, code,
-- jurisdiction and rooftop scope whose effective intervals overlap are not a
-- disagreement to resolve at read time; they are a rule book that cannot say
-- what the tax is. `uq_desking_rules_no_overlap` refuses the second one at
-- write time, which is the only place the answer is still cheap. An unscoped
-- (tenant-wide) rule and a rooftop-scoped one do NOT collide: the rooftop is
-- part of the key, and a rooftop rule deliberately overrides the tenant default
-- for its own rooftop — resolution prefers the more specific scope.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE desking_rules (
  rule_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rule_kind               TEXT NOT NULL
                            CHECK (rule_kind IN ('tax', 'fee', 'incentive', 'valuation', 'policy')),
  rule_code               TEXT NOT NULL CHECK (rule_code ~ '^[a-z0-9_]{2,40}$'),
  label                   TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  -- WHO SAYS SO. A statute, a schedule, a manufacturer bulletin, a rooftop
  -- policy memo. Free text because the world is, but NOT NULL because a rule
  -- nobody can attribute is a number somebody typed.
  source                  TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 200),
  jurisdiction            TEXT NOT NULL CHECK (jurisdiction ~ '^[A-Z0-9-]{2,40}$'),
  -- NULL means every rooftop in the tenant. A value means this rooftop only,
  -- and it wins over the tenant-wide rule of the same kind and code.
  rooftop_id              UUID,
  version                 INTEGER NOT NULL CHECK (version >= 1),
  effective_from          TIMESTAMPTZ NOT NULL,
  effective_to            TIMESTAMPTZ,
  basis                   TEXT NOT NULL
                            CHECK (basis IN ('rate_ppm', 'flat_amount')),
  -- Parts per million: 6.5% is 65000. Integer, because Row 3 requires identical
  -- inputs to reproduce identical outputs and a float cannot promise it.
  rate_ppm                BIGINT CHECK (rate_ppm IS NULL OR rate_ppm BETWEEN 0 AND 100000000),
  amount_cents            BIGINT,
  currency                TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  applies_to              TEXT NOT NULL
                            CHECK (applies_to IN ('vehicle_price', 'taxable_amount', 'total')),
  recorded_by_user_link_id UUID NOT NULL,
  recorded_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, rule_id),
  UNIQUE (tenant_id, rule_kind, rule_code, version),
  CONSTRAINT ck_rule_interval CHECK (effective_to IS NULL OR effective_to > effective_from),
  CONSTRAINT ck_rule_value_matches_basis CHECK (
    (basis = 'rate_ppm' AND rate_ppm IS NOT NULL AND amount_cents IS NULL)
    OR
    (basis = 'flat_amount' AND amount_cents IS NOT NULL AND rate_ppm IS NULL)
  ),
  -- An incentive is money off and a fee is money on; both are recorded as
  -- POSITIVE magnitudes and the calculator decides the sign, so that a rule
  -- book cannot be read backwards by a reader who missed a minus.
  CONSTRAINT ck_rule_amount_non_negative CHECK (amount_cents IS NULL OR amount_cents >= 0),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, recorded_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id),
  CONSTRAINT uq_desking_rules_no_overlap EXCLUDE USING gist (
    tenant_id WITH =,
    rule_kind WITH =,
    rule_code WITH =,
    jurisdiction WITH =,
    (COALESCE(rooftop_id, '00000000-0000-0000-0000-000000000000'::uuid)) WITH =,
    tstzrange(effective_from, effective_to) WITH &&
  )
);
CREATE INDEX idx_desking_rules_lookup
  ON desking_rules (tenant_id, rule_kind, jurisdiction, effective_from DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 4 — THE SCENARIOS
--
-- A SCENARIO IS AN IMMUTABLE VERSION, NOT A ROW THAT MOVES. Revising a deal
-- writes a NEW scenario carrying `supersedes_scenario_id`; the old one keeps
-- every figure a manager may already have looked at. The only column that ever
-- changes on an existing scenario is `state`, and section 10's trigger is what
-- holds that true for every role rather than only for the service.
--
-- DETERMINISM, MADE CHECKABLE. `input_fingerprint` is a digest over the
-- scenario's explicit inputs AND the exact (rule id, version) list resolved for
-- it; `output_fingerprint` is a digest over the computed figures. Two scenarios
-- with the same input fingerprint and different output fingerprints mean the
-- calculator changed under the deal, and `tests/desking-scenarios.test.ts` is
-- what fails when they do.
--
-- ONE CURRENT APPROVED VERSION PER OPPORTUNITY. `uq_scenario_one_approved_per_case`
-- is a partial unique index, so the rule is the database's rather than the
-- service's — and since a case is unique per opportunity, "one per case" and
-- "one per opportunity" are the same sentence.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE desking_scenarios (
  scenario_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rooftop_id              UUID NOT NULL,
  desking_case_id         UUID NOT NULL,
  version_no              INTEGER NOT NULL CHECK (version_no >= 1),
  supersedes_scenario_id  UUID,
  label                   TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 80),
  state                   TEXT NOT NULL DEFAULT 'draft'
                            CHECK (state IN ('draft', 'submitted', 'approved', 'rejected',
                                             'expired', 'superseded')),
  -- ── the inputs, explicit and versioned ──────────────────────────────────
  vehicle_price_cents     BIGINT NOT NULL CHECK (vehicle_price_cents >= 0),
  trade_allowance_cents   BIGINT NOT NULL DEFAULT 0 CHECK (trade_allowance_cents >= 0),
  trade_payoff_cents      BIGINT NOT NULL DEFAULT 0 CHECK (trade_payoff_cents >= 0),
  cash_down_cents         BIGINT NOT NULL DEFAULT 0 CHECK (cash_down_cents >= 0),
  term_months             INTEGER CHECK (term_months IS NULL OR term_months BETWEEN 1 AND 120),
  apr_ppm                 BIGINT CHECK (apr_ppm IS NULL OR apr_ppm BETWEEN 0 AND 1000000),
  currency                TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  jurisdiction            TEXT NOT NULL CHECK (jurisdiction ~ '^[A-Z0-9-]{2,40}$'),
  -- The instant the rule book was read at. Two scenarios priced at the same
  -- instant see the same rules, which is what makes a comparison a comparison.
  priced_at               TIMESTAMPTZ NOT NULL,
  -- ── the outputs, computed from exactly those inputs ─────────────────────
  trade_equity_cents      BIGINT NOT NULL,
  taxable_amount_cents    BIGINT NOT NULL CHECK (taxable_amount_cents >= 0),
  tax_total_cents         BIGINT NOT NULL CHECK (tax_total_cents >= 0),
  fee_total_cents         BIGINT NOT NULL CHECK (fee_total_cents >= 0),
  incentive_total_cents   BIGINT NOT NULL CHECK (incentive_total_cents >= 0),
  amount_financed_cents   BIGINT NOT NULL,
  monthly_payment_cents   BIGINT CHECK (monthly_payment_cents IS NULL OR monthly_payment_cents >= 0),
  -- ── determinism ─────────────────────────────────────────────────────────
  input_fingerprint       TEXT NOT NULL CHECK (input_fingerprint ~ '^[0-9a-f]{64}$'),
  output_fingerprint      TEXT NOT NULL CHECK (output_fingerprint ~ '^[0-9a-f]{64}$'),
  built_by_user_link_id   UUID NOT NULL,
  built_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at              TIMESTAMPTZ,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, scenario_id),
  UNIQUE (tenant_id, desking_case_id, version_no),
  CONSTRAINT ck_scenario_finance_pair
    CHECK ((term_months IS NULL) = (apr_ppm IS NULL)),
  CONSTRAINT ck_scenario_payment_needs_finance
    CHECK (monthly_payment_cents IS NULL OR term_months IS NOT NULL),
  CONSTRAINT ck_scenario_expiry_after_pricing
    CHECK (expires_at IS NULL OR expires_at > priced_at),
  CONSTRAINT ck_scenario_supersedes_not_self
    CHECK (supersedes_scenario_id IS NULL OR supersedes_scenario_id <> scenario_id),
  FOREIGN KEY (tenant_id, desking_case_id) REFERENCES desking_cases (tenant_id, desking_case_id),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, supersedes_scenario_id)
    REFERENCES desking_scenarios (tenant_id, scenario_id),
  FOREIGN KEY (tenant_id, built_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);
CREATE UNIQUE INDEX uq_scenario_one_approved_per_case
  ON desking_scenarios (tenant_id, desking_case_id) WHERE state = 'approved';
CREATE INDEX idx_scenarios_case
  ON desking_scenarios (tenant_id, desking_case_id, version_no DESC);

CREATE TABLE scenario_line_items (
  line_item_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  scenario_id             UUID NOT NULL,
  sequence_no             INTEGER NOT NULL CHECK (sequence_no >= 1),
  kind                    TEXT NOT NULL
                            CHECK (kind IN ('price', 'trade', 'tax', 'fee', 'incentive',
                                            'down_payment')),
  code                    TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 40),
  label                   TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 120),
  -- SIGNED, because a line item is what it does to the balance. The magnitudes
  -- in the rule book are positive; the sign is decided once, here, by the
  -- calculator that knows whether it is adding or taking away.
  amount_cents            BIGINT NOT NULL,
  rule_id                 UUID,
  rule_version            INTEGER,
  UNIQUE (tenant_id, line_item_id),
  UNIQUE (tenant_id, scenario_id, sequence_no),
  CONSTRAINT ck_line_item_rule_pair CHECK ((rule_id IS NULL) = (rule_version IS NULL)),
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES desking_scenarios (tenant_id, scenario_id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES desking_rules (tenant_id, rule_id)
);

-- WHAT THE SCENARIO WAS COMPUTED UNDER, copied rather than joined. A rule
-- superseded tomorrow must not change what a manager approved today, so the
-- source, jurisdiction, interval and version are recorded here at application
-- time. This table is Row 4's audit and Row 5's freeze, together.
CREATE TABLE scenario_rule_applications (
  application_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  scenario_id             UUID NOT NULL,
  rule_id                 UUID NOT NULL,
  rule_kind               TEXT NOT NULL,
  rule_code               TEXT NOT NULL,
  rule_version            INTEGER NOT NULL,
  source                  TEXT NOT NULL,
  jurisdiction            TEXT NOT NULL,
  rooftop_scoped          BOOLEAN NOT NULL,
  effective_from          TIMESTAMPTZ NOT NULL,
  effective_to            TIMESTAMPTZ,
  resolved_amount_cents   BIGINT NOT NULL,
  UNIQUE (tenant_id, application_id),
  UNIQUE (tenant_id, scenario_id, rule_id),
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES desking_scenarios (tenant_id, scenario_id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES desking_rules (tenant_id, rule_id)
);

CREATE TABLE scenario_state_events (
  event_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  scenario_id             UUID NOT NULL,
  from_state              TEXT NOT NULL,
  to_state                TEXT NOT NULL,
  reason                  TEXT CHECK (reason IS NULL OR length(reason) <= 400),
  changed_by_user_link_id UUID NOT NULL,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, event_id),
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES desking_scenarios (tenant_id, scenario_id),
  FOREIGN KEY (tenant_id, changed_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_scenario_state_events_scenario
  ON scenario_state_events (tenant_id, scenario_id, occurred_at);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 5 — APPROVAL AND FREEZE
--
-- A DECISION IS ONE ROW, WRITTEN ONCE, ABOUT ONE EXACT VERSION. The unique key
-- on (tenant_id, scenario_id) makes a second decision on the same version
-- impossible; `reviewed_output_fingerprint` names the figures the manager
-- actually saw, and section 10's trigger refuses the write when it does not
-- match the scenario's own — which is how "approval freezes the exact reviewed
-- version" stops being a claim about the UI and becomes one about the database.
--
-- REJECTION, EXPIRY AND SUPERSESSION ARE MODELLED, NOT ERASED. A rejected
-- version stays rejected and keeps its decision row; a superseded one keeps
-- every figure it carried. Nothing in this phase deletes a scenario or edits a
-- decision, and the grants below say so.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE scenario_approvals (
  approval_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  desking_case_id         UUID NOT NULL,
  scenario_id             UUID NOT NULL,
  scenario_version_no     INTEGER NOT NULL CHECK (scenario_version_no >= 1),
  decision                TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  -- THE EXACT VERSION REVIEWED. Not "the current one at commit time".
  reviewed_output_fingerprint TEXT NOT NULL CHECK (reviewed_output_fingerprint ~ '^[0-9a-f]{64}$'),
  decided_by_user_link_id UUID NOT NULL,
  -- ONE IMMUTABLE DECISION TIME.
  decided_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  override_reason         TEXT CHECK (override_reason IS NULL OR length(override_reason) <= 400),
  limit_reason            TEXT CHECK (limit_reason IS NULL OR length(limit_reason) <= 400),
  UNIQUE (tenant_id, approval_id),
  -- ONE DECISION PER VERSION.
  UNIQUE (tenant_id, scenario_id),
  CONSTRAINT ck_approval_rejection_states_why
    CHECK (decision = 'approved' OR limit_reason IS NOT NULL),
  FOREIGN KEY (tenant_id, desking_case_id) REFERENCES desking_cases (tenant_id, desking_case_id),
  FOREIGN KEY (tenant_id, scenario_id) REFERENCES desking_scenarios (tenant_id, scenario_id),
  FOREIGN KEY (tenant_id, decided_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_scenario_approvals_case
  ON scenario_approvals (tenant_id, desking_case_id, decided_at);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 6 — THE RELEASE TRAIN 4 SEAM, RELAXED
--
-- Migration 064 shipped `desking_handoffs.desking_status` pinned to
-- NOT_YET_AVAILABLE by `ck_desking_pre_fbl120`, and said in its own header that
-- FBL-120 would be the phase that relaxed it. This is that relaxation, and it
-- is the whole of it: the column's CHECK already admits both values, so the
-- pin comes off and the runtime gains UPDATE on that ONE column. Nothing else
-- about migration 064 changes, and 064's own bytes are untouched.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE desking_handoffs DROP CONSTRAINT ck_desking_pre_fbl120;
GRANT UPDATE (desking_status) ON desking_handoffs TO dealership_runtime;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 7 — GRANTS
--
-- The rule the earlier trains applied, applied again: the runtime may correct
-- current state and may only ADD to history. DELETE is granted NOWHERE in this
-- phase — an appraisal version, a line item, a rule application and a decision
-- are all things that happened, and a desk that can delete what happened is a
-- desk whose approved history means nothing.
-- ────────────────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON
  desking_cases, appraisals, desking_scenarios
  TO dealership_runtime;

GRANT SELECT, INSERT ON
  appraisal_versions, appraisal_damage_items, appraisal_equipment,
  appraisal_observations, appraisal_attachments, appraisal_source_quotations,
  desking_rules, scenario_line_items, scenario_rule_applications,
  scenario_state_events, scenario_approvals
  TO dealership_runtime;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 8 — THE RESOURCE REGISTRY
--
-- Three new rooftop-owned resources: a desking case, an appraisal and a
-- scenario. Everything hanging off them — versions, damage, equipment,
-- observations, attachments, quotations, line items, rule applications, state
-- events and decisions — is authorized THROUGH its parent, exactly as the
-- earlier trains' children are.
--
-- THE RULE BOOK IS NOT A RESOURCE, DELIBERATELY. A tenant-wide rule has no
-- rooftop, so a resolver would have to return NULL for it and migration 059
-- refuses an unresolvable resource. Rules are therefore written through a
-- resource-less action carrying a rooftop scope hint, and the service checks
-- the actor reaches that rooftop — the same shape RT4 used for its create
-- commands, and for the same reason.
--
-- BOTH resolvers are re-declared and must stay in step, exactly as migration
-- 064 left them: `resource_org_leaf` keeps the row-security bypass and is
-- executable only by `dealership_evidence_owner`, while
-- `resource_org_leaf_visible` is the ordinary lookup the engine calls.
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
  END IF;
  RETURN leaf;
END;
$$ LANGUAGE plpgsql STABLE;

REVOKE ALL ON FUNCTION resource_org_leaf_visible(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resource_org_leaf_visible(text, uuid) TO dealership_runtime;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 9 — DENY-BY-DEFAULT ROW SECURITY
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE desking_cases              ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisals                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisal_versions         ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisal_damage_items     ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisal_equipment        ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisal_observations     ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisal_attachments      ENABLE ROW LEVEL SECURITY;
ALTER TABLE appraisal_source_quotations ENABLE ROW LEVEL SECURITY;
ALTER TABLE desking_rules              ENABLE ROW LEVEL SECURITY;
ALTER TABLE desking_scenarios          ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_line_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_rule_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_state_events      ENABLE ROW LEVEL SECURITY;
ALTER TABLE scenario_approvals         ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_desking_cases_tenant ON desking_cases
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_appraisals_tenant ON appraisals
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_appraisal_versions_tenant ON appraisal_versions
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_appraisal_damage_items_tenant ON appraisal_damage_items
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_appraisal_equipment_tenant ON appraisal_equipment
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_appraisal_observations_tenant ON appraisal_observations
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_appraisal_attachments_tenant ON appraisal_attachments
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_appraisal_source_quotations_tenant ON appraisal_source_quotations
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_desking_rules_tenant ON desking_rules
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_desking_scenarios_tenant ON desking_scenarios
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_scenario_line_items_tenant ON scenario_line_items
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_scenario_rule_applications_tenant ON scenario_rule_applications
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_scenario_state_events_tenant ON scenario_state_events
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_scenario_approvals_tenant ON scenario_approvals
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());

-- ────────────────────────────────────────────────────────────────────────────
-- Section 10 — THE TRIGGERS THAT FREEZE AN APPROVED VERSION
--
-- Grants can stop a role from writing a TABLE; they cannot stop it from
-- editing a row that has already been decided. These three triggers can, and
-- they hold for every role rather than only for the service that happens to be
-- calling — which is the difference between a rule and a habit.
-- ────────────────────────────────────────────────────────────────────────────

-- (a) A SCENARIO'S FIGURES ARE WRITTEN ONCE. `state` moves; nothing else does.
--     A revision is a NEW version with `supersedes_scenario_id` set, so there
--     is never a reason to edit a figure in place, and every reason not to.
CREATE OR REPLACE FUNCTION desking_scenarios_freeze()
RETURNS trigger
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.scenario_id <> OLD.scenario_id
     OR NEW.tenant_id <> OLD.tenant_id
     OR NEW.desking_case_id <> OLD.desking_case_id
     OR NEW.rooftop_id <> OLD.rooftop_id
     OR NEW.version_no <> OLD.version_no
     OR NEW.vehicle_price_cents <> OLD.vehicle_price_cents
     OR NEW.trade_allowance_cents <> OLD.trade_allowance_cents
     OR NEW.trade_payoff_cents <> OLD.trade_payoff_cents
     OR NEW.cash_down_cents <> OLD.cash_down_cents
     OR NEW.term_months IS DISTINCT FROM OLD.term_months
     OR NEW.apr_ppm IS DISTINCT FROM OLD.apr_ppm
     OR NEW.currency <> OLD.currency
     OR NEW.jurisdiction <> OLD.jurisdiction
     OR NEW.priced_at <> OLD.priced_at
     OR NEW.trade_equity_cents <> OLD.trade_equity_cents
     OR NEW.taxable_amount_cents <> OLD.taxable_amount_cents
     OR NEW.tax_total_cents <> OLD.tax_total_cents
     OR NEW.fee_total_cents <> OLD.fee_total_cents
     OR NEW.incentive_total_cents <> OLD.incentive_total_cents
     OR NEW.amount_financed_cents <> OLD.amount_financed_cents
     OR NEW.monthly_payment_cents IS DISTINCT FROM OLD.monthly_payment_cents
     OR NEW.input_fingerprint <> OLD.input_fingerprint
     OR NEW.output_fingerprint <> OLD.output_fingerprint
     OR NEW.built_by_user_link_id <> OLD.built_by_user_link_id
     OR NEW.built_at <> OLD.built_at
  THEN
    RAISE EXCEPTION
      'desking_scenarios UPDATE refused: version % of case % is a written version, and its '
      'inputs, figures and fingerprints cannot be edited — revise the deal by building the '
      'next version, which supersedes this one and leaves what a manager saw intact',
      OLD.version_no, OLD.desking_case_id;
  END IF;

  -- A DECIDED VERSION IS FINISHED. An approved one may only be superseded; a
  -- rejected, expired or superseded one may not move at all.
  IF OLD.state = 'approved' AND NEW.state <> 'approved' AND NEW.state <> 'superseded' THEN
    RAISE EXCEPTION
      'desking_scenarios UPDATE refused: an approved version may only be superseded, not '
      'moved to % — rewriting a decision is not a state change',
      NEW.state;
  END IF;
  IF OLD.state IN ('rejected', 'expired', 'superseded') AND NEW.state <> OLD.state THEN
    RAISE EXCEPTION
      'desking_scenarios UPDATE refused: % is a final state and % is not reachable from it',
      OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_desking_scenarios_freeze
  BEFORE UPDATE ON desking_scenarios
  FOR EACH ROW EXECUTE FUNCTION desking_scenarios_freeze();

-- (b) A DECISION BINDS THE EXACT VERSION REVIEWED. Approving figures that have
--     since been rebuilt is the failure this refuses: the fingerprint the
--     manager saw must be the fingerprint the row carries.
CREATE OR REPLACE FUNCTION scenario_approvals_bind_reviewed_version()
RETURNS trigger
SET search_path = public, pg_temp
AS $$
DECLARE
  s RECORD;
BEGIN
  SELECT output_fingerprint, version_no, desking_case_id, state
    INTO s
    FROM desking_scenarios
   WHERE tenant_id = NEW.tenant_id AND scenario_id = NEW.scenario_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'scenario_approvals INSERT refused: scenario % does not exist in tenant %',
      NEW.scenario_id, NEW.tenant_id;
  END IF;
  IF s.output_fingerprint <> NEW.reviewed_output_fingerprint THEN
    RAISE EXCEPTION
      'scenario_approvals INSERT refused: the decision names reviewed figures % and version % '
      'carries % — a decision binds the exact version reviewed, so re-read it and decide again',
      NEW.reviewed_output_fingerprint, s.version_no, s.output_fingerprint;
  END IF;
  IF s.desking_case_id <> NEW.desking_case_id THEN
    RAISE EXCEPTION
      'scenario_approvals INSERT refused: scenario % belongs to case %, not %',
      NEW.scenario_id, s.desking_case_id, NEW.desking_case_id;
  END IF;
  IF s.version_no <> NEW.scenario_version_no THEN
    RAISE EXCEPTION
      'scenario_approvals INSERT refused: scenario % is version %, and the decision names %',
      NEW.scenario_id, s.version_no, NEW.scenario_version_no;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_scenario_approvals_bind_reviewed_version
  BEFORE INSERT ON scenario_approvals
  FOR EACH ROW EXECUTE FUNCTION scenario_approvals_bind_reviewed_version();

-- (c) AN APPRAISAL VERSION IS EVIDENCE, AND EVIDENCE DOES NOT GET EDITED. The
--     runtime holds no UPDATE grant on the table; this refuses it for every
--     other role too, because "who could rewrite the walk-around" is a question
--     the schema should answer rather than the deployment.
CREATE OR REPLACE FUNCTION appraisal_versions_append_only()
RETURNS trigger
SET search_path = public, pg_temp
AS $$
BEGIN
  RAISE EXCEPTION
    'appraisal_versions % refused: an appraisal version is evidence recorded at an instant — '
    'correct it by recording the next version, which keeps who said what, and when',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_appraisal_versions_append_only
  BEFORE UPDATE OR DELETE ON appraisal_versions
  FOR EACH ROW EXECUTE FUNCTION appraisal_versions_append_only();
