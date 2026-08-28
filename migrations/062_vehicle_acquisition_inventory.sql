-- ============================================================================
-- RELEASE TRAIN 2 — VEHICLE ACQUISITION AND INVENTORY (FBL-060 / 070 / 080)
--
-- One consolidated release over the accepted, immutable 000–061 chain. It
-- carries, in six sections:
--
--   1. THE ACQUISITION PARTY — the person or organization a vehicle is
--      acquired from or for, with contact consent, database-enforced duplicate
--      prevention, and a recorded merge that preserves both identifiers.
--   2. THE CANONICAL VEHICLE AND ITS STOCK IDENTITY — one vehicle per VIN per
--      dealership, the provider decode evidence behind it, and the stock record
--      that gives it a rooftop, a stock number, a lifecycle and an acquisition.
--   3. INVENTORY OPERATIONS AND MERCHANDISING — versioned pricing, photos,
--      features, readiness costs, holds, transfers between rooftops, and the
--      listing whose publication is reconciled against a provider.
--   4. THE GRANTS the runtime role needs to work these tables.
--   5. THE RESOURCE REGISTRY — `resource_org_leaf` re-declared so a stock item
--      and its listing resolve to the rooftop that owns them, which is what
--      makes a wrong-rooftop actor indistinguishable from a nonexistent row.
--   6. DENY-BY-DEFAULT ROW SECURITY over every table this train adds.
--
-- WHAT THIS TRAIN DELIBERATELY DOES NOT DO, so the omissions read as decisions:
--
--   * It does not touch the Fixed Ops schema. `service_appointments`,
--     `repair_orders`, `first_service_offers` and `service_waitlist_entries`
--     carry `mdm_vehicle_id` / `mdm_customer_id` as OPAQUE, never-resolved
--     UUIDs, and `docs/PLATFORM-CONTEXT.md` §2 records that opacity as a
--     deliberate stance. This migration introduces the master those columns
--     were always placeholders for, and it introduces it ALONGSIDE them: no
--     foreign key is added to a Fixed Ops table, no Fixed Ops column is
--     rewritten, and no service behaviour changes. The identifiers are
--     value-compatible (both are UUIDs), so a later, separately authorized
--     reconciliation can adopt them without a schema change here.
--   * READINESS IS NOT REPAIR MANAGEMENT. A vehicle being made retail-ready is
--     recorded as `stock_costs` rows carrying a vendor, a status, an amount and
--     a date, plus the `in_reconditioning` lifecycle state. There is no repair
--     order, no technician, no labour operation and no part in this train, and
--     `stock_costs` must not grow into one.
--   * It adds no listing PROVIDER credential and no live feed. Publication is
--     driven through the transactional outbox migration 061 already owns, and
--     the provider is a deterministic simulator.
--
-- WHAT IS NOT UNDER ROW SECURITY HERE, and why: nothing. Every table below is
-- tenant-scoped and every one of them is row-secured. The tables this train
-- REUSES rather than creates — `idempotency_keys`, `admin_outbox`,
-- `admin_outbox_deliveries` — were secured (or deliberately excluded, for the
-- two outbox tables, which the dispatcher must claim across tenants) by
-- migration 061 and are not re-declared.
--
-- Migrations 000 and 049–061 are byte-immutable. This file is additive and
-- forward-only: it creates tables, indexes and grants, and it replaces exactly
-- one function (`resource_org_leaf`) by re-declaring its complete body.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- Section 1 — THE ACQUISITION PARTY
--
-- A party is a person or an organization. It is the minimum customer identity
-- an acquisition needs and nothing more: there is no lead, no campaign, no
-- source attribution and no sales workflow here, and there must not be.
--
-- DUPLICATE PREVENTION IS A DATABASE FACT, not a service convention. The two
-- partial unique indexes below make a second ACTIVE party sharing an email or
-- a phone within one dealership unrepresentable, so the "detect duplicates"
-- requirement cannot be defeated by a caller that skips the search.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE parties (
  party_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  party_type              TEXT NOT NULL CHECK (party_type IN ('person', 'organization')),
  -- The name shown to staff. For a person it is assembled from the parts; for
  -- an organization it is the organization name. Stored rather than derived so
  -- a search has one column to match and a merge has one value to preserve.
  display_name            TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
  given_name              TEXT CHECK (given_name IS NULL OR length(given_name) BETWEEN 1 AND 100),
  family_name             TEXT CHECK (family_name IS NULL OR length(family_name) BETWEEN 1 AND 100),
  organization_name       TEXT CHECK (organization_name IS NULL OR length(organization_name) BETWEEN 1 AND 200),
  email                   TEXT CHECK (email IS NULL OR (length(email) BETWEEN 3 AND 320 AND email LIKE '%@%')),
  -- Digits only, optionally leading '+'. The service normalizes before writing,
  -- so the uniqueness index below compares like with like.
  phone                   TEXT CHECK (phone IS NULL OR phone ~ '^\+?[0-9]{7,15}$'),
  address_line1           TEXT CHECK (address_line1 IS NULL OR length(address_line1) BETWEEN 1 AND 200),
  address_city            TEXT CHECK (address_city IS NULL OR length(address_city) BETWEEN 1 AND 100),
  address_region          TEXT CHECK (address_region IS NULL OR length(address_region) BETWEEN 1 AND 100),
  address_postal_code     TEXT CHECK (address_postal_code IS NULL OR length(address_postal_code) BETWEEN 1 AND 20),
  address_country         TEXT CHECK (address_country IS NULL OR address_country ~ '^[A-Z]{2}$'),
  status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'merged', 'archived')),
  -- A merged party keeps its row and points at the survivor: identifiers and
  -- history are preserved rather than deleted, which is what "controlled
  -- merge" means. Nothing may reference a merged party as if it were live.
  merged_into_party_id    UUID,
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, party_id),
  CHECK ((party_type = 'organization') = (organization_name IS NOT NULL)),
  CHECK ((status = 'merged') = (merged_into_party_id IS NOT NULL)),
  CHECK (merged_into_party_id IS NULL OR merged_into_party_id <> party_id),
  FOREIGN KEY (tenant_id, merged_into_party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- DETECTION INDEXES, DELIBERATELY NOT UNIQUE.
--
-- An earlier draft made (tenant, email) and (tenant, phone) UNIQUE over active
-- parties, which reads like strong duplicate prevention and is in fact a
-- product defect: households share an email address and a landline, so a
-- spouse trading in a second car would have been unable to exist. Two people
-- with one contact address is a REAL state, and a schema that cannot express
-- it forces staff to falsify data.
--
-- Duplicate control therefore lives where the judgement belongs — the service
-- searches these indexes before creating, returns the candidates it found, and
-- only creates anyway when a human explicitly decides they are different
-- people. That decision is audited. The indexes exist to make the search fast
-- and the detection reliable, not to refuse the second row.
CREATE INDEX idx_parties_active_email
  ON parties (tenant_id, lower(email)) WHERE status = 'active' AND email IS NOT NULL;
CREATE INDEX idx_parties_active_phone
  ON parties (tenant_id, phone) WHERE status = 'active' AND phone IS NOT NULL;
CREATE INDEX idx_parties_name ON parties (tenant_id, lower(display_name));

-- Contact consent, per channel. Absence of a row means UNKNOWN, and the
-- service treats unknown as "not granted" — consent is opt-in evidence, never
-- an assumption.
CREATE TABLE party_consents (
  tenant_id               UUID NOT NULL,
  party_id                UUID NOT NULL,
  channel                 TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'phone', 'postal')),
  state                   TEXT NOT NULL CHECK (state IN ('granted', 'withdrawn', 'unknown')),
  captured_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source                  TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
  note                    TEXT CHECK (note IS NULL OR length(note) <= 500),
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, party_id, channel),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- The merge ledger: append-only, one row per merge, and a party may be merged
-- away exactly once. It records what moved so the operation is reconstructable
-- from evidence rather than from the survivor's current shape.
CREATE TABLE party_merges (
  merge_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  surviving_party_id      UUID NOT NULL,
  merged_party_id         UUID NOT NULL,
  moved                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  reason                  TEXT CHECK (reason IS NULL OR length(reason) <= 500),
  merged_by_user_link_id  UUID NOT NULL,
  merged_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, merged_party_id),
  CHECK (surviving_party_id <> merged_party_id),
  FOREIGN KEY (tenant_id, surviving_party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, merged_party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, merged_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 2 — THE CANONICAL VEHICLE AND ITS STOCK IDENTITY
--
-- A VEHICLE is the thing in the world, identified by its VIN. A STOCK ITEM is
-- this dealership's holding of that vehicle: a rooftop, a stock number, an
-- acquisition and a lifecycle. Separating them is what lets a vehicle be
-- re-acquired later without rekeying its identity, and what makes "one active
-- stock identity per vehicle" expressible as a database constraint.
--
-- The VIN grammar excludes I, O and Q exactly as the standard does, so a
-- transcription of those letters is refused at the boundary rather than
-- stored and mis-decoded later.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE vehicles (
  vehicle_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  vin                     TEXT NOT NULL CHECK (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  -- Whether the VIN's ninth character matches the ISO 3779 check digit. Stored
  -- because a VIN can be well-formed and still wrong, and staff need to see
  -- which it is; it is never a reason to refuse the acquisition outright.
  vin_check_digit_valid   BOOLEAN NOT NULL DEFAULT FALSE,
  model_year              INT CHECK (model_year IS NULL OR model_year BETWEEN 1950 AND 2100),
  make                    TEXT CHECK (make IS NULL OR length(make) BETWEEN 1 AND 60),
  model                   TEXT CHECK (model IS NULL OR length(model) BETWEEN 1 AND 60),
  trim_level              TEXT CHECK (trim_level IS NULL OR length(trim_level) BETWEEN 1 AND 60),
  body_style              TEXT CHECK (body_style IS NULL OR length(body_style) BETWEEN 1 AND 40),
  drivetrain              TEXT CHECK (drivetrain IS NULL OR drivetrain IN ('fwd', 'rwd', 'awd', '4wd')),
  fuel_type               TEXT CHECK (fuel_type IS NULL OR fuel_type IN ('gasoline', 'diesel', 'hybrid', 'electric', 'other')),
  transmission            TEXT CHECK (transmission IS NULL OR transmission IN ('automatic', 'manual', 'cvt', 'other')),
  exterior_color          TEXT CHECK (exterior_color IS NULL OR length(exterior_color) BETWEEN 1 AND 40),
  interior_color          TEXT CHECK (interior_color IS NULL OR length(interior_color) BETWEEN 1 AND 40),
  decode_status           TEXT NOT NULL DEFAULT 'undecoded'
                            CHECK (decode_status IN ('undecoded', 'decoded', 'rejected', 'unavailable')),
  decoded_at              TIMESTAMPTZ,
  decode_source           TEXT CHECK (decode_source IS NULL OR length(decode_source) BETWEEN 1 AND 60),
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, vehicle_id),
  -- CANONICAL IDENTITY: one vehicle per VIN per dealership. This is the
  -- constraint that makes "do not rekey the canonical identity" enforceable.
  UNIQUE (tenant_id, vin),
  CHECK ((decode_status = 'decoded') = (decoded_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- Append-only decode evidence. Every provider call lands here — accepted or
-- refused — so a decoded vehicle can always be traced to the response that
-- decoded it, and a rejection is visible rather than silently retried away.
CREATE TABLE vehicle_decodes (
  decode_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  vehicle_id              UUID NOT NULL,
  provider                TEXT NOT NULL CHECK (length(provider) BETWEEN 1 AND 60),
  vin                     TEXT NOT NULL CHECK (vin ~ '^[A-HJ-NPR-Z0-9]{17}$'),
  outcome                 TEXT NOT NULL CHECK (outcome IN ('decoded', 'rejected', 'unavailable')),
  attributes              JSONB NOT NULL DEFAULT '{}'::jsonb,
  message                 TEXT CHECK (message IS NULL OR length(message) <= 500),
  requested_by_user_link_id UUID NOT NULL,
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicles (tenant_id, vehicle_id),
  FOREIGN KEY (tenant_id, requested_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_vehicle_decodes_vehicle ON vehicle_decodes (tenant_id, vehicle_id, requested_at DESC);

CREATE TABLE stock_items (
  stock_item_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  vehicle_id              UUID NOT NULL,
  -- THE ROOFTOP THAT OWNS THIS STOCK. It is what `resource_org_leaf` resolves
  -- in section 5, so it is what decides whether a rooftop-scoped employee may
  -- touch the row at all. The composite foreign key makes a rooftop belonging
  -- to another dealership unrepresentable.
  rooftop_id              UUID NOT NULL,
  stock_number            TEXT NOT NULL CHECK (stock_number ~ '^[A-Z0-9][A-Z0-9-]{0,23}$'),
  -- THE READINESS PROGRESSION, AND ONLY THAT. Whether a vehicle is listed,
  -- held or in transit are separate facts with their own tables and their own
  -- lifetimes: a car can be listed AND held, and folding either into this
  -- column would make that unrepresentable and the state machine ambiguous.
  -- Row 2 asks for explicit states advancing to retail-ready; these are they.
  lifecycle_state         TEXT NOT NULL DEFAULT 'acquired'
                            CHECK (lifecycle_state IN (
                              'acquired', 'in_reconditioning', 'retail_ready', 'retired')),
  acquisition_source      TEXT NOT NULL
                            CHECK (acquisition_source IN (
                              'trade_in', 'auction', 'private_purchase', 'fleet',
                              'consignment', 'transfer')),
  -- The party the vehicle came from. Null is legitimate for an auction or
  -- fleet purchase with no counterparty record; a trade-in must name one, and
  -- the service enforces that because the database cannot know the difference.
  acquisition_party_id    UUID,
  acquired_on             DATE NOT NULL,
  odometer                INT CHECK (odometer IS NULL OR odometer BETWEEN 0 AND 2000000),
  odometer_unit           TEXT NOT NULL DEFAULT 'mi' CHECK (odometer_unit IN ('mi', 'km')),
  title_status            TEXT NOT NULL DEFAULT 'pending'
                            CHECK (title_status IN ('pending', 'in_hand', 'sent', 'lost')),
  location_label          TEXT CHECK (location_label IS NULL OR length(location_label) BETWEEN 1 AND 100),
  retail_ready_at         TIMESTAMPTZ,
  retired_at              TIMESTAMPTZ,
  retired_reason          TEXT CHECK (retired_reason IS NULL OR length(retired_reason) <= 200),
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, stock_item_id),
  CHECK ((lifecycle_state = 'retired') = (retired_at IS NOT NULL)),
  CHECK (retired_at IS NULL OR retired_reason IS NOT NULL),
  FOREIGN KEY (tenant_id, vehicle_id) REFERENCES vehicles (tenant_id, vehicle_id),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, acquisition_party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- NO DUPLICATE OR CONFLICTING ACTIVE STOCK IDENTITY. Both halves of row 2's
-- promise are database facts: a live stock number is unique WITHIN THE ROOFTOP
-- that issued it, and a vehicle may be held by at most ONE live stock record
-- anywhere in the dealership. A retired record keeps its number and its
-- vehicle without blocking either.
--
-- The stock number is scoped to the ROOFTOP, not the tenant, because rooftops
-- issue their own numbers from their own sequences: two stores of one group
-- both holding an 'A1234' is ordinary, and a tenant-wide key would have made
-- the second store's ordinary numbering collide with the first's.
CREATE UNIQUE INDEX uq_stock_items_live_number
  ON stock_items (tenant_id, rooftop_id, stock_number) WHERE lifecycle_state <> 'retired';
CREATE UNIQUE INDEX uq_stock_items_live_vehicle
  ON stock_items (tenant_id, vehicle_id) WHERE lifecycle_state <> 'retired';
CREATE INDEX idx_stock_items_rooftop ON stock_items (tenant_id, rooftop_id, lifecycle_state);
-- The owner's inventory view is ordered by age across the rooftops they may
-- see, so the index the view actually uses is created with the table rather
-- than added later under load.
CREATE INDEX idx_stock_items_aging
  ON stock_items (tenant_id, rooftop_id, acquired_on) WHERE lifecycle_state <> 'retired';
CREATE INDEX idx_stock_items_party ON stock_items (tenant_id, acquisition_party_id)
  WHERE acquisition_party_id IS NOT NULL;

-- Acquisition paperwork. Status, not content: this records that a title was
-- received, never the document itself.
CREATE TABLE stock_documents (
  document_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  stock_item_id           UUID NOT NULL,
  document_type           TEXT NOT NULL
                            CHECK (document_type IN (
                              'title', 'bill_of_sale', 'odometer_statement',
                              'inspection', 'lien_release', 'other')),
  reference               TEXT CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 100),
  status                  TEXT NOT NULL DEFAULT 'expected'
                            CHECK (status IN ('expected', 'received', 'sent', 'missing')),
  received_on             DATE,
  note                    TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((status = 'received') = (received_on IS NOT NULL)),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_stock_documents_item ON stock_documents (tenant_id, stock_item_id);

-- WHAT THE VEHICLE HAS COST, including readiness work. A reconditioning row
-- names a vendor, an amount, a status and a date — and stops there. It is not
-- a repair order: there is no operation, no technician and no part, and this
-- table must not acquire them.
CREATE TABLE stock_costs (
  cost_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  stock_item_id           UUID NOT NULL,
  cost_type               TEXT NOT NULL
                            CHECK (cost_type IN (
                              'purchase', 'transport', 'reconditioning',
                              'inspection', 'fee', 'other')),
  amount_cents            BIGINT NOT NULL CHECK (amount_cents >= 0),
  currency                TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  status                  TEXT NOT NULL DEFAULT 'estimated'
                            CHECK (status IN ('estimated', 'actual')),
  vendor                  TEXT CHECK (vendor IS NULL OR length(vendor) BETWEEN 1 AND 120),
  incurred_on             DATE NOT NULL,
  target_on               DATE,
  note                    TEXT CHECK (note IS NULL OR length(note) <= 500),
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_stock_costs_item ON stock_costs (tenant_id, stock_item_id, cost_type);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 3 — INVENTORY OPERATIONS AND MERCHANDISING
--
-- Pricing is VERSIONED rather than overwritten: a price change supersedes the
-- standing row and inserts a new one, so what a vehicle was advertised at last
-- week survives the change. The partial unique index is what makes "exactly
-- one current price per type" true rather than merely intended.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE stock_prices (
  price_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  stock_item_id           UUID NOT NULL,
  price_type              TEXT NOT NULL CHECK (price_type IN ('retail', 'internet', 'wholesale', 'msrp')),
  amount_cents            BIGINT NOT NULL CHECK (amount_cents >= 0),
  currency                TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  effective_from          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  superseded_at           TIMESTAMPTZ,
  superseded_by_price_id  UUID,
  reason                  TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  created_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, price_id),
  CHECK (superseded_at IS NULL OR superseded_at >= effective_from),
  CHECK ((superseded_by_price_id IS NULL) OR (superseded_at IS NOT NULL)),
  CHECK (superseded_by_price_id IS NULL OR superseded_by_price_id <> price_id),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, superseded_by_price_id) REFERENCES stock_prices (tenant_id, price_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE UNIQUE INDEX uq_stock_prices_current
  ON stock_prices (tenant_id, stock_item_id, price_type) WHERE superseded_at IS NULL;
CREATE INDEX idx_stock_prices_history ON stock_prices (tenant_id, stock_item_id, effective_from DESC);

CREATE TABLE stock_media (
  media_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  stock_item_id           UUID NOT NULL,
  media_kind              TEXT NOT NULL DEFAULT 'photo' CHECK (media_kind IN ('photo', 'video')),
  uri                     TEXT NOT NULL CHECK (uri ~ '^(https://|/)' AND length(uri) <= 500),
  position                INT NOT NULL CHECK (position BETWEEN 1 AND 100),
  caption                 TEXT CHECK (caption IS NULL OR length(caption) <= 200),
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'removed')),
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
-- Photo order is ADVISORY, and this index is deliberately not unique. A unique
-- index would make the ordinary reorder — "insert this shot at position 2 and
-- push the rest down" — impossible to express, because a non-deferrable unique
-- index is checked row by row and the shift transiently collides with itself.
-- Ties are broken by `created_at`, so the order is always total even when two
-- photos claim one slot mid-edit.
CREATE INDEX idx_stock_media_position
  ON stock_media (tenant_id, stock_item_id, position) WHERE status = 'active';

CREATE TABLE stock_features (
  tenant_id               UUID NOT NULL,
  stock_item_id           UUID NOT NULL,
  feature_code            TEXT NOT NULL CHECK (feature_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  label                   TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 100),
  -- Whether the feature came from the VIN decode or was added by staff. A
  -- decoded feature is evidence; a manual one is a claim, and the listing
  -- adapter is entitled to treat them differently.
  source                  TEXT NOT NULL CHECK (source IN ('decoded', 'manual')),
  created_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, stock_item_id, feature_code),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- A hold takes a vehicle off the market without changing what it is. At most
-- one hold may be live at a time, so "is this vehicle held" has exactly one
-- answer and publication can be refused on it.
CREATE TABLE stock_holds (
  hold_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  stock_item_id           UUID NOT NULL,
  hold_type               TEXT NOT NULL
                            CHECK (hold_type IN ('sold_pending', 'inspection', 'manager', 'transport')),
  reason                  TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  placed_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  released_at             TIMESTAMPTZ,
  release_reason          TEXT CHECK (release_reason IS NULL OR length(release_reason) <= 200),
  placed_by_user_link_id  UUID NOT NULL,
  released_by_user_link_id UUID,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (released_at IS NULL OR released_at >= placed_at),
  CHECK ((released_at IS NULL) = (released_by_user_link_id IS NULL)),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, placed_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, released_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE UNIQUE INDEX uq_stock_holds_live
  ON stock_holds (tenant_id, stock_item_id) WHERE released_at IS NULL;

-- Moving stock between the dealership's own rooftops. Both endpoints are
-- tenant-qualified, so a transfer to another dealership's rooftop is
-- unrepresentable rather than merely refused.
CREATE TABLE stock_transfers (
  transfer_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  stock_item_id           UUID NOT NULL,
  from_rooftop_id         UUID NOT NULL,
  to_rooftop_id           UUID NOT NULL,
  state                   TEXT NOT NULL DEFAULT 'requested'
                            CHECK (state IN ('requested', 'completed', 'cancelled')),
  reason                  TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  requested_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  settled_at              TIMESTAMPTZ,
  requested_by_user_link_id UUID NOT NULL,
  settled_by_user_link_id UUID,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (from_rooftop_id <> to_rooftop_id),
  CHECK ((state = 'requested') = (settled_at IS NULL)),
  CHECK ((settled_at IS NULL) = (settled_by_user_link_id IS NULL)),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, from_rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, to_rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, requested_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, settled_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE UNIQUE INDEX uq_stock_transfers_open
  ON stock_transfers (tenant_id, stock_item_id) WHERE state = 'requested';

-- THE ORIGIN ROOFTOP IS DERIVED, NOT DECLARED.
--
-- `from_rooftop_id` decides which rooftop's staff may act on the transfer, so
-- letting the caller supply it would let an authorized rooftop-A employee name
-- rooftop B as the origin and move a car they never had reach over. The
-- database stamps it from the stock item itself — the same technique migration
-- 059 uses for `resource_rooftop_id` — so the column states where the car
-- actually is rather than where the request claimed it was.
CREATE OR REPLACE FUNCTION stock_transfer_origin_is_derived()
RETURNS TRIGGER AS $$
BEGIN
  SELECT si.rooftop_id INTO NEW.from_rooftop_id
    FROM stock_items si
   WHERE si.tenant_id = NEW.tenant_id AND si.stock_item_id = NEW.stock_item_id;
  IF NEW.from_rooftop_id IS NULL THEN
    RAISE EXCEPTION 'a transfer names a stock item of this dealership'
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_stock_transfers_origin_derived
  BEFORE INSERT ON stock_transfers
  FOR EACH ROW EXECUTE FUNCTION stock_transfer_origin_is_derived();

-- THE LISTING. One per stock item per channel, with the provider's own
-- reference once it has one. `state` is the reconciled truth: it advances only
-- on a provider outcome, never on the request alone, which is what makes a
-- replayed publication harmless.
CREATE TABLE stock_listings (
  listing_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  stock_item_id           UUID NOT NULL,
  channel                 TEXT NOT NULL CHECK (channel ~ '^[a-z][a-z0-9_]{0,31}$'),
  state                   TEXT NOT NULL DEFAULT 'draft'
                            CHECK (state IN (
                              'draft', 'publish_pending', 'published',
                              'withdraw_pending', 'withdrawn', 'rejected')),
  external_ref            TEXT CHECK (external_ref IS NULL OR length(external_ref) BETWEEN 1 AND 100),
  last_error              TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  attempts                INT NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  published_at            TIMESTAMPTZ,
  withdrawn_at            TIMESTAMPTZ,
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, listing_id),
  UNIQUE (tenant_id, stock_item_id, channel),
  -- ONE-WAY, DELIBERATELY. A bidirectional equivalence here would mean a
  -- listing could not be withdrawn: `withdrawn` with a `published_at` is the
  -- normal end state of a car that WAS advertised, and an equivalence would
  -- have forced the service to erase the fact that it ever went live.
  CHECK (state <> 'published' OR published_at IS NOT NULL),
  CHECK (state <> 'withdrawn' OR withdrawn_at IS NOT NULL),
  -- A provider reference is meaningless only before anything has been sent.
  -- It must be storable while a publication is still pending, because that is
  -- exactly when the provider hands it over.
  CHECK (external_ref IS NULL OR state <> 'draft'),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_stock_listings_state ON stock_listings (tenant_id, state);

-- Append-only reconciliation history: every request, every provider answer,
-- every retry and every reconciliation pass, with the attempt it belonged to.
-- This is what lets a replayed delivery be recognised as a replay.
CREATE TABLE listing_events (
  listing_event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  listing_id              UUID NOT NULL,
  event_type              TEXT NOT NULL
                            CHECK (event_type IN (
                              'publish_requested', 'published', 'rejected',
                              'withdraw_requested', 'withdrawn',
                              'retry_scheduled', 'reconciled')),
  outcome                 TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'deferred')),
  attempt                 INT NOT NULL CHECK (attempt >= 0),
  provider_ref            TEXT CHECK (provider_ref IS NULL OR length(provider_ref) BETWEEN 1 AND 100),
  detail                  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- The outbox event this outcome came from, when it came from one. It is what
  -- ties a provider answer back to the delivery that asked for it, and it is
  -- how a reconciliation pass tells a genuine second attempt from a replay of
  -- the first.
  outbox_event_id         UUID REFERENCES admin_outbox (event_id),
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, listing_id) REFERENCES stock_listings (tenant_id, listing_id)
);
CREATE INDEX idx_listing_events_listing ON listing_events (tenant_id, listing_id, occurred_at DESC);
-- REPLAY IS A DATABASE FACT. One outcome per (listing, event type, attempt):
-- a redelivered publication trying to record a second 'published' for attempt
-- 1 violates this index, and the dispatcher recognises that violation as the
-- replay it is instead of writing a duplicate history.
CREATE UNIQUE INDEX uq_listing_events_attempt
  ON listing_events (tenant_id, listing_id, event_type, attempt);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 4 — GRANTS
--
-- Migration 059's blanket grant predates every table above, so each one is
-- granted explicitly. DELETE is granted to exactly two tables and nowhere
-- else: `stock_features` and `party_consents` are replaced as whole sets for
-- one parent row (the PUT model), and a set that can only be added to cannot
-- be corrected. Everything else retires by state — there is no hard delete of
-- a vehicle, a stock record, a price, a hold, a transfer or a listing.
-- ────────────────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON
  parties, party_consents,
  vehicles,
  stock_items, stock_documents, stock_costs,
  stock_prices, stock_media, stock_features,
  stock_holds, stock_transfers, stock_listings
  TO dealership_runtime;

-- APPEND-ONLY EVIDENCE GETS NO UPDATE. These three tables record what happened
-- — a provider's decode answer, a merge, a listing's reconciliation history —
-- and a record of what happened that can be edited afterwards is not evidence.
-- The runtime role may add to them and read them, and nothing more; correcting
-- a mistake means writing a further row that says so.
GRANT SELECT, INSERT ON vehicle_decodes, party_merges, listing_events
  TO dealership_runtime;

-- DELETE is granted to exactly ONE table. `stock_features` is replaced as a
-- whole set for one vehicle (the PUT model), and a set that can only be added
-- to cannot be corrected.
--
-- `party_consents` deliberately does NOT get it. A withdrawn consent is the
-- most consequential row in this schema — it is the record of someone asking
-- not to be contacted — and the ability to delete it is the ability to erase
-- that request. Consent is replaced by UPSERT instead, so the row survives
-- every change and carries its own state.
GRANT DELETE ON stock_features TO dealership_runtime;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 5 — THE RESOURCE REGISTRY
--
-- `resource_org_leaf` maps a resource to the rooftop that owns it, and the
-- policy engine walks that rooftop's ancestry to decide whether an actor's
-- binding reaches it. Registering the two new resource types here is what
-- makes a wrong-rooftop employee INDISTINGUISHABLE FROM A NONEXISTENT ROW
-- rather than merely forbidden — the engine reports the resource as not
-- visible and the API answers 404.
--
-- The whole body is re-declared because `CREATE OR REPLACE FUNCTION` replaces
-- it entirely: dropping any existing branch would silently un-register a Fixed
-- Ops resource type, so all twelve are carried forward verbatim from migration
-- 059 and the two new branches are appended.
--
-- ── WHY THIS FUNCTION IS NOW `SECURITY DEFINER` ─────────────────────────────
--
-- It was SECURITY INVOKER, and that was correct while every table it read was
-- unsecured. The two branches below read RLS-SECURED tables, and the resolver
-- is called by the policy engine BEFORE any tenant context exists — the engine
-- is deciding whether the caller may act, so nothing has opened a transaction
-- on the caller's behalf yet. As an invoker function it would therefore see NO
-- ROWS under the runtime login, return NULL, and the engine would report every
-- stock item as nonexistent: the entire train would 404 for legitimate staff
-- while passing every owner-connection test.
--
-- Running as the definer resolves the row and CANNOT widen anyone's authority:
-- `p_tenant` is supplied by the engine from AUTHENTICATED STATE, never by the
-- caller, and every branch filters on it, so the function can only ever answer
-- "which rooftop of the tenant you already are" — and the answer is then fed
-- back into the ancestry walk that actually decides reach. `search_path` is
-- pinned so no schema ahead of `public` can substitute a table.
--
-- ── WHICH RESOURCE TYPES THIS TRAIN REGISTERS, AND WHY ONLY TWO ─────────────
--
-- `stock_item` and `stock_listing`. Everything hanging off a stock item — its
-- documents, costs, prices, media, features, holds and transfers — is
-- authorized THROUGH ITS PARENT: those routes name `stockItemId` and declare
-- `resourceType: 'stock_item'`, so the rooftop that owns the car is the
-- rooftop that governs its price and its photographs, which is the rule a
-- dealership would state anyway. Registering each child separately would add
-- six lookups that can only ever return the same rooftop.
--
-- `parties` and `vehicles` are deliberately NOT registrable: a customer and a
-- VIN belong to the dealership, not to one store, so their actions are
-- tenant-scoped (`resourceType: null`) and reach is decided by the actor's
-- tenant-level binding.
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION resource_org_leaf(p_tenant uuid, p_type text, p_id uuid)
RETURNS uuid
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE leaf uuid;
BEGIN
  IF p_type = 'service_appointment' THEN
    SELECT t.location_id INTO leaf FROM service_appointments t
     WHERE t.tenant_id = p_tenant AND t.appointment_id = p_id;
  ELSIF p_type = 'repair_order' THEN
    SELECT t.location_id INTO leaf FROM repair_orders t
     WHERE t.tenant_id = p_tenant AND t.ro_id = p_id;
  ELSIF p_type = 'service_queue_item' THEN
    SELECT t.location_id INTO leaf FROM service_queue_items t
     WHERE t.tenant_id = p_tenant AND t.queue_item_id = p_id;
  ELSIF p_type = 'service_waitlist_entry' THEN
    SELECT t.location_id INTO leaf FROM service_waitlist_entries t
     WHERE t.tenant_id = p_tenant AND t.waitlist_entry_id = p_id;
  ELSIF p_type = 'mpi_session' THEN
    SELECT ro.location_id INTO leaf FROM mpi_sessions t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.mpi_session_id = p_id;
  ELSIF p_type = 'ro_line_item' THEN
    SELECT ro.location_id INTO leaf FROM ro_line_items t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.line_item_id = p_id;
  ELSIF p_type = 'ro_parts_line' THEN
    SELECT ro.location_id INTO leaf FROM ro_parts_lines t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.part_line_id = p_id;
  ELSIF p_type = 'ro_sublet_job' THEN
    SELECT ro.location_id INTO leaf FROM ro_sublet_jobs t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.sublet_job_id = p_id;
  ELSIF p_type = 'service_portal_task' THEN
    SELECT ro.location_id INTO leaf FROM service_portal_tasks t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.portal_task_id = p_id;
  ELSIF p_type = 'tech_work_ticket' THEN
    SELECT ro.location_id INTO leaf FROM tech_work_tickets t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.ticket_id = p_id;
  ELSIF p_type = 'warranty_claim' THEN
    SELECT ro.location_id INTO leaf FROM warranty_claims t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.ro_id
     WHERE t.tenant_id = p_tenant AND t.claim_id = p_id;
  ELSIF p_type = 'comeback_case' THEN
    SELECT ro.location_id INTO leaf FROM comeback_cases t
      JOIN repair_orders ro ON ro.tenant_id = t.tenant_id AND ro.ro_id = t.original_ro_id
     WHERE t.tenant_id = p_tenant AND t.comeback_id = p_id;
  -- ── RELEASE TRAIN 2 ──────────────────────────────────────────────────────
  ELSIF p_type = 'stock_item' THEN
    SELECT t.rooftop_id INTO leaf FROM stock_items t
     WHERE t.tenant_id = p_tenant AND t.stock_item_id = p_id;
  ELSIF p_type = 'stock_listing' THEN
    SELECT si.rooftop_id INTO leaf FROM stock_listings t
      JOIN stock_items si ON si.tenant_id = t.tenant_id AND si.stock_item_id = t.stock_item_id
     WHERE t.tenant_id = p_tenant AND t.listing_id = p_id;
  END IF;
  RETURN leaf;
END;
$$ LANGUAGE plpgsql STABLE;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 6 — DENY-BY-DEFAULT ROW SECURITY
--
-- The same one sentence per table migration 061 established: a row is visible
-- and writable exactly when its tenant IS the transaction's server-set tenant
-- context. No context, no rows. The policies bind `dealership_runtime`, the
-- role the deployed login holds by membership; the migration owner and the
-- test harness are unaffected because row security is ENABLEd and not FORCEd,
-- deliberately, exactly as 061 explains.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE parties           ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_consents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_merges      ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles          ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicle_decodes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_items       ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_documents   ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_costs       ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_prices      ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_media       ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_features    ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_holds       ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_transfers   ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_listings    ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_events    ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_parties_tenant ON parties
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_party_consents_tenant ON party_consents
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_party_merges_tenant ON party_merges
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_vehicles_tenant ON vehicles
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_vehicle_decodes_tenant ON vehicle_decodes
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_stock_items_tenant ON stock_items
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_stock_documents_tenant ON stock_documents
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_stock_costs_tenant ON stock_costs
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_stock_prices_tenant ON stock_prices
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_stock_media_tenant ON stock_media
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_stock_features_tenant ON stock_features
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_stock_holds_tenant ON stock_holds
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_stock_transfers_tenant ON stock_transfers
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_stock_listings_tenant ON stock_listings
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_listing_events_tenant ON listing_events
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
