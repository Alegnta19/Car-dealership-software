-- ──────────────────────────────────────────────────────────────
-- Phase 248 — service waitlist
--
-- Customers who want service sooner than the schedule allows, waiting for a slot to
-- open. The concept comes from the origin platform's phase-229 sketch
-- (service_waitlist_entries); the implementation here is new — the sketch had no tenant
-- scoping, no closed transitions, no uniqueness and no conversion path, and none of its
-- code is imported (docs/PLATFORM-CONTEXT.md records that decision).
--
-- Lifecycle: waiting → offered → scheduled, with canceled and expired as the other
-- terminals. `scheduled` means a real appointment row exists and `appointment_id`
-- points at it — the conversion happens in one transaction, so a waitlist entry never
-- claims an appointment that was not created.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS service_waitlist_entries (
  waitlist_entry_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                 UUID NOT NULL,
  location_id               UUID NOT NULL,
  mdm_customer_id           UUID NOT NULL,
  mdm_vehicle_id            UUID NOT NULL,
  requested_start           TIMESTAMPTZ NOT NULL,
  requested_end             TIMESTAMPTZ,
  concerns                  JSONB NOT NULL DEFAULT '[]',
  priority                  TEXT NOT NULL DEFAULT 'p1' CHECK (priority IN ('p0','p1','p2')),
  preferred_contact_channel TEXT NOT NULL DEFAULT 'sms' CHECK (preferred_contact_channel IN ('sms','email','phone','portal')),
  language_preference       TEXT NOT NULL DEFAULT 'en' CHECK (language_preference IN ('en','es','auto')),
  status                    TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','offered','scheduled','canceled','expired')),
  offer_expires_at          TIMESTAMPTZ,
  appointment_id            UUID REFERENCES service_appointments(appointment_id),
  notes                     TEXT,
  created_by_user_id        UUID NOT NULL,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_swe_tenant_status ON service_waitlist_entries (tenant_id, status, priority, requested_start);
CREATE INDEX IF NOT EXISTS idx_swe_location      ON service_waitlist_entries (tenant_id, location_id, status);

-- One open entry per vehicle per location. The service layer checks first and answers
-- 409; this is the database backstop for the race two concurrent creates would win
-- together — same pattern as the check-in idempotency index on repair_orders.
CREATE UNIQUE INDEX IF NOT EXISTS uq_swe_open_vehicle
  ON service_waitlist_entries (tenant_id, location_id, mdm_vehicle_id)
  WHERE status IN ('waiting','offered');

-- `set_updated_at` exists from migration 050 and is already attached to the other
-- phase-248 tables; new tables attach their own trigger explicitly.
DROP TRIGGER IF EXISTS trg_service_waitlist_entries_updated_at ON service_waitlist_entries;
CREATE TRIGGER trg_service_waitlist_entries_updated_at
  BEFORE UPDATE ON service_waitlist_entries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- An appointment can now record that it was born from the waitlist. The CHECK is
-- re-created rather than altered in place (inline CHECKs get auto-generated names,
-- but this one's name is deterministic), and NOT VALID per repo convention — every
-- existing row passes, but constraint additions over populated tables do not get to
-- assume that.
ALTER TABLE service_appointments
  DROP CONSTRAINT IF EXISTS service_appointments_source_check;
ALTER TABLE service_appointments
  ADD CONSTRAINT service_appointments_source_check CHECK (source IN (
    'walk_in','phone','web','sales_handoff','waitlist')) NOT VALID;
