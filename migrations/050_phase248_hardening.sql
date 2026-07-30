-- ============================================================
-- Phase 248 — Hardening follow-up
--
-- Closes the medium/low findings that need schema support. Kept as a separate
-- migration rather than an edit to 049, which is now published and may already
-- have been applied.
--
-- Requires: 049_phase248_service_cockpit.sql
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1) updated_at maintenance
--
-- 049 left updated_at to application discipline, so any statement that forgot it
-- silently froze the column at insert time. A trigger makes it structural.
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'service_appointments','repair_orders','ro_line_items','mpi_templates','mpi_sessions',
    'mpi_results','service_recommendations','ro_estimates','ro_authorizations','ro_parts_lines',
    'ro_sublet_jobs','tech_profiles','tech_work_tickets','warranty_claims','comeback_cases',
    'service_queue_items','service_portal_tasks'
  ] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON %I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t, t);
  END LOOP;
END;
$$;

-- ──────────────────────────────────────────────────────────────
-- 2) DMRS2 — one result per checklist item per inspection
--
-- Without this, re-recording an item duplicated it and produced a duplicate
-- customer recommendation on submit. The service now upserts on this key.
-- ──────────────────────────────────────────────────────────────

-- ctid breaks ties: created_at alone leaves same-instant duplicates on both sides
-- of the comparison, so neither is deleted and the unique index then fails to build.
DELETE FROM mpi_results a
  USING mpi_results b
 WHERE a.mpi_session_id = b.mpi_session_id
   AND a.item_key = b.item_key
   AND (a.created_at, a.ctid) < (b.created_at, b.ctid);

CREATE UNIQUE INDEX IF NOT EXISTS uq_mpir_session_item ON mpi_results (mpi_session_id, item_key);

-- ──────────────────────────────────────────────────────────────
-- 3) Step-up token consumption ledger
--
-- Step-up tokens were replayable for their whole lifetime. Recording the jti
-- inside the same transaction as the privileged write makes a token single-use:
-- the primary key rejects the second attempt, and a rolled-back operation
-- releases the token with it.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS step_up_token_uses (
  jti                     UUID PRIMARY KEY,
  tenant_id               UUID NOT NULL,
  user_id                 UUID NOT NULL,
  action                  TEXT NOT NULL,
  resource_id             UUID NOT NULL,
  expires_at              TIMESTAMPTZ NOT NULL,
  consumed_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Supports pruning consumed tokens once they can no longer be replayed.
CREATE INDEX IF NOT EXISTS idx_sutu_expires ON step_up_token_uses (expires_at);

-- ──────────────────────────────────────────────────────────────
-- 4) PSFSRB2 — first-service offer bridge
--
-- The deal linkage lived only in the appointment's concerns JSON, so a converted
-- appointment could not be attributed back to its deal and the capture-rate
-- metric had no denominator.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS first_service_offers (
  offer_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  location_id             UUID NOT NULL,
  deal_id                 UUID NOT NULL,
  mdm_customer_id         UUID NOT NULL,
  mdm_vehicle_id          UUID NOT NULL,
  appointment_id          UUID NOT NULL REFERENCES service_appointments(appointment_id),
  ro_id                   UUID REFERENCES repair_orders(ro_id),
  status                  TEXT NOT NULL DEFAULT 'offered' CHECK (status IN (
                            'offered','scheduled','converted','lapsed','canceled')),
  offered_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  converted_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_fso_deal        ON first_service_offers (tenant_id, deal_id);
CREATE INDEX        IF NOT EXISTS idx_fso_appt       ON first_service_offers (appointment_id);
CREATE INDEX        IF NOT EXISTS idx_fso_location   ON first_service_offers (tenant_id, location_id, status);

DROP TRIGGER IF EXISTS trg_first_service_offers_updated_at ON first_service_offers;
CREATE TRIGGER trg_first_service_offers_updated_at
  BEFORE UPDATE ON first_service_offers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────
-- 5) TDTS2 — technician capacity
--
-- tech_profiles existed but nothing read or wrote it, which is also why the three
-- technician metrics had no input. Scheduled hours give utilization a denominator.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE tech_profiles
  ADD COLUMN IF NOT EXISTS scheduled_hours_per_week NUMERIC NOT NULL DEFAULT 40
    CHECK (scheduled_hours_per_week > 0 AND scheduled_hours_per_week <= 168);

-- ──────────────────────────────────────────────────────────────
-- 6) Closed vocabularies
--
-- Both columns are used as grouping keys — free text meant unbounded values in
-- queue filters and in comeback reporting.
-- ──────────────────────────────────────────────────────────────

-- NOT VALID: both columns were free text in 049, so a database that already holds rows
-- may carry values outside these sets. Validating on ADD would abort this migration —
-- and because the runner applies files in order and stops on failure, every later
-- migration would be unreachable too. NOT VALID constrains all new writes immediately
-- and leaves history alone; run VALIDATE CONSTRAINT once the data is cleaned.
ALTER TABLE service_queue_items
  DROP CONSTRAINT IF EXISTS service_queue_items_queue_type_check;
ALTER TABLE service_queue_items
  ADD CONSTRAINT service_queue_items_queue_type_check CHECK (queue_type IN (
    'appointments_today','waiting_checkin','waiting_authorization','waiting_parts',
    'in_repair','qc','ready_pickup','comeback_review','no_show_followup')) NOT VALID;

ALTER TABLE comeback_cases
  DROP CONSTRAINT IF EXISTS comeback_cases_root_cause_check;
ALTER TABLE comeback_cases
  ADD CONSTRAINT comeback_cases_root_cause_check CHECK (root_cause_category IN (
    'workmanship','parts_failure','misdiagnosis','incomplete_repair',
    'customer_expectation','vendor_sublet','unrelated')) NOT VALID;

-- ──────────────────────────────────────────────────────────────
-- 7) Indexes for the aggregation job
--
-- The metrics aggregator scans recent activity per location; these keep those
-- sweeps off sequential scans.
-- ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_ro_location_created ON repair_orders (tenant_id, location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rpl_status_updated  ON ro_parts_lines (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cc_created          ON comeback_cases (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sr_status_created   ON service_recommendations (tenant_id, status, created_at DESC);

-- ============================================================
-- Total: 2 new tables, 1 column, 18 triggers, 1 function,
--        9 index statements, 2 replaced CHECK constraints
-- ============================================================
