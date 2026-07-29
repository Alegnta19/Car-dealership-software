-- ============================================================
-- Phase 248 — Metrics support and 050 corrections
--
-- Requires: 050_phase248_hardening.sql
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1) POS2 — when a part actually arrived
--
-- Parts wait time was measured from `updated_at`, which moves on every later
-- status change, so a part was re-observed as a new (longer) wait each time it
-- progressed from received to picked to installed. A dedicated timestamp is set
-- once, on first receipt, and never moves again.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE ro_parts_lines ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ;

-- Best-effort backfill for rows that were already received before this column
-- existed: updated_at is the closest approximation available.
UPDATE ro_parts_lines
   SET received_at = updated_at
 WHERE received_at IS NULL
   AND status IN ('received', 'picked', 'installed');

CREATE INDEX IF NOT EXISTS idx_rpl_received ON ro_parts_lines (received_at) WHERE received_at IS NOT NULL;

-- ──────────────────────────────────────────────────────────────
-- 2) SSR2 — SLA defaults per queue
--
-- `sla_due_at` was nullable and never written, so the SLA breach rate had no
-- population to measure. Each queue gets a default target; a caller may still
-- pass an explicit due time.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS service_sla_defaults (
  tenant_id               UUID NOT NULL,
  queue_type              TEXT NOT NULL,
  target_minutes          INT NOT NULL CHECK (target_minutes > 0),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, queue_type)
);

DROP TRIGGER IF EXISTS trg_service_sla_defaults_updated_at ON service_sla_defaults;
CREATE TRIGGER trg_service_sla_defaults_updated_at
  BEFORE UPDATE ON service_sla_defaults
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ──────────────────────────────────────────────────────────────
-- 3) Corrections to 050
--
-- The comeback-rate denominator needs the set of repair orders that CLOSED in a
-- window, which the current status cannot answer once a comeback flips the row
-- out of `closed`. The event log can, given an index for it.
-- ──────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_roev_status_to
  ON ro_events (tenant_id, occurred_at DESC)
  WHERE event_type = 'status_changed';

-- 050 created this trigger without a guard, so re-applying it errored. Replace it
-- with the same drop-then-create shape used for every other table.
DROP TRIGGER IF EXISTS trg_first_service_offers_updated_at ON first_service_offers;
CREATE TRIGGER trg_first_service_offers_updated_at
  BEFORE UPDATE ON first_service_offers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 050 added these CHECKs validating immediately, which fails on a database that
-- already holds free-text values from 049. NOT VALID constrains new writes while
-- leaving history alone; validate them separately once the data is cleaned.
ALTER TABLE service_queue_items DROP CONSTRAINT IF EXISTS service_queue_items_queue_type_check;
ALTER TABLE service_queue_items
  ADD CONSTRAINT service_queue_items_queue_type_check CHECK (queue_type IN (
    'appointments_today','waiting_checkin','waiting_authorization','waiting_parts',
    'in_repair','qc','ready_pickup','comeback_review','no_show_followup')) NOT VALID;

ALTER TABLE comeback_cases DROP CONSTRAINT IF EXISTS comeback_cases_root_cause_check;
ALTER TABLE comeback_cases
  ADD CONSTRAINT comeback_cases_root_cause_check CHECK (root_cause_category IN (
    'workmanship','parts_failure','misdiagnosis','incomplete_repair',
    'customer_expectation','vendor_sublet','unrelated')) NOT VALID;

-- ============================================================
-- Total: 1 table, 1 column, 1 trigger, 2 indexes, 2 revalidated CHECKs
-- ============================================================
