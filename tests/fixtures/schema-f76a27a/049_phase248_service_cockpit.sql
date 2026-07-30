-- ============================================================
-- Phase 248 — Service Cockpit v2 & Fixed Ops Operations Platform
-- Migration 049 — 20 tables, comprehensive indexes
--
-- Subdomains (13):
--   1)  SCM2    — Service Cockpit Module v2
--   2)  SSIS2   — Service Scheduling & Intake
--   3)  ROLS2   — Repair Order Lifecycle
--   4)  DMRS2   — Digital MPI & Recommendations
--   5)  EAS2    — Estimate & Authorization
--   6)  POS2    — Parts Operations
--   7)  SOS2    — Sublet Operations
--   8)  TDTS2   — Technician Dispatch & Time
--   9)  WPCS2   — Warranty & Policy Compliance
--   10) QCS2    — Quality & Comebacks
--   11) SSR2    — Service SLA & Runbook Integration
--   12) CSPP2   — Customer Service Portal Packager
--   13) PSFSRB2 — Post-Sale First Service Retention Bridge
--
-- Requires: 000_platform_core.sql (audit_events, pgcrypto)
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1) SSIS2 — Service Appointments
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS service_appointments (
  appointment_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  location_id             UUID NOT NULL,
  mdm_customer_id         UUID NOT NULL,
  mdm_vehicle_id          UUID NOT NULL,
  scheduled_start         TIMESTAMPTZ NOT NULL,
  scheduled_end           TIMESTAMPTZ,
  status                  TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
                            'requested','scheduled','confirmed','checked_in',
                            'no_show','canceled','completed','converted_to_ro')),
  concerns                JSONB NOT NULL DEFAULT '[]',
  preferred_contact_channel TEXT DEFAULT 'sms',
  language_preference     TEXT NOT NULL DEFAULT 'en' CHECK (language_preference IN ('en','es','auto')),
  created_by_user_id      UUID,
  source                  TEXT NOT NULL DEFAULT 'phone' CHECK (source IN ('walk_in','phone','web','sales_handoff')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sa_tenant_loc   ON service_appointments (tenant_id, location_id, status);
CREATE INDEX IF NOT EXISTS idx_sa_scheduled    ON service_appointments (tenant_id, location_id, scheduled_start);
CREATE INDEX IF NOT EXISTS idx_sa_customer     ON service_appointments (mdm_customer_id);
CREATE INDEX IF NOT EXISTS idx_sa_vehicle      ON service_appointments (mdm_vehicle_id);

CREATE TABLE IF NOT EXISTS service_appointment_events (
  event_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id          UUID NOT NULL REFERENCES service_appointments(appointment_id),
  tenant_id               UUID NOT NULL,
  event_type              TEXT NOT NULL,
  actor_ref               JSONB NOT NULL DEFAULT '{}',
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sae_appt ON service_appointment_events (appointment_id, occurred_at DESC);

-- ──────────────────────────────────────────────────────────────
-- 2) ROLS2 — Repair Orders & Line Items
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS repair_orders (
  ro_id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  location_id             UUID NOT NULL,
  appointment_id          UUID REFERENCES service_appointments(appointment_id),
  mdm_customer_id         UUID NOT NULL,
  mdm_vehicle_id          UUID NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                            'draft','checked_in','inspection_in_progress','estimate_pending',
                            'awaiting_authorization','authorized','in_repair','waiting_parts',
                            'sublet_in_progress','qc','ready_for_pickup','closed','canceled','comeback')),
  pay_type_mix            JSONB NOT NULL DEFAULT '{}',
  odometer                INT,
  promised_time           TIMESTAMPTZ,
  advisor_user_id         UUID,
  created_by_user_id      UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ro_tenant_status ON repair_orders (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_ro_location      ON repair_orders (tenant_id, location_id, status);
CREATE INDEX IF NOT EXISTS idx_ro_customer      ON repair_orders (mdm_customer_id);
CREATE INDEX IF NOT EXISTS idx_ro_vehicle       ON repair_orders (mdm_vehicle_id);
-- UNIQUE: one appointment converts to at most one repair order. This is the database
-- backstop for check-in idempotency — two concurrent check-ins on separate connections
-- cannot both create an RO for the same appointment.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ro_appointment ON repair_orders (appointment_id) WHERE appointment_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ro_events (
  ro_event_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ro_id                   UUID NOT NULL REFERENCES repair_orders(ro_id),
  tenant_id               UUID NOT NULL,
  event_type              TEXT NOT NULL,
  actor_ref               JSONB NOT NULL DEFAULT '{}',
  payload_ref             JSONB NOT NULL DEFAULT '{}',
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_roev_ro ON ro_events (ro_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS ro_line_items (
  line_item_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  ro_id                   UUID NOT NULL REFERENCES repair_orders(ro_id),
  line_type               TEXT NOT NULL CHECK (line_type IN ('labor','parts','sublet','fee')),
  category                TEXT,
  description             TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                            'proposed','approved','declined','in_progress','completed','canceled')),
  authorization_status    TEXT NOT NULL DEFAULT 'not_required' CHECK (authorization_status IN (
                            'not_required','pending','approved','declined')),
  authorization_ref       UUID,
  assigned_tech_user_id   UUID,
  labor_op_code           TEXT,
  estimated_hours         NUMERIC CHECK (estimated_hours IS NULL OR estimated_hours >= 0),
  sold_hours              NUMERIC CHECK (sold_hours IS NULL OR sold_hours >= 0),
  price_ref               JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_roli_ro     ON ro_line_items (ro_id, status);
CREATE INDEX IF NOT EXISTS idx_roli_tech   ON ro_line_items (assigned_tech_user_id, status) WHERE assigned_tech_user_id IS NOT NULL;

-- ──────────────────────────────────────────────────────────────
-- 3) DMRS2 — Digital MPI
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mpi_templates (
  template_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  location_id             UUID,
  name                    TEXT NOT NULL,
  version                 INT NOT NULL DEFAULT 1,
  items                   JSONB NOT NULL DEFAULT '[]',
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deprecated')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mpit_tenant ON mpi_templates (tenant_id, status);

CREATE TABLE IF NOT EXISTS mpi_sessions (
  mpi_session_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  ro_id                   UUID NOT NULL REFERENCES repair_orders(ro_id),
  template_id             UUID NOT NULL REFERENCES mpi_templates(template_id),
  status                  TEXT NOT NULL DEFAULT 'started' CHECK (status IN (
                            'started','in_progress','submitted','reviewed','closed')),
  tech_user_id            UUID NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mpis_ro       ON mpi_sessions (ro_id, status);
CREATE INDEX IF NOT EXISTS idx_mpis_template ON mpi_sessions (template_id);

CREATE TABLE IF NOT EXISTS mpi_results (
  result_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  mpi_session_id          UUID NOT NULL REFERENCES mpi_sessions(mpi_session_id),
  item_key                TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('pass','attention','fail')),
  severity                TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','maintenance','safety')),
  notes                   TEXT,
  evidence_artifact_refs  TEXT[] DEFAULT '{}',
  recommended_action_ref  UUID,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mpir_session ON mpi_results (mpi_session_id);

CREATE TABLE IF NOT EXISTS service_recommendations (
  recommendation_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  -- FK added: every other ro_id in this schema is constrained; this one was not,
  -- allowing orphaned recommendations.
  ro_id                   UUID NOT NULL REFERENCES repair_orders(ro_id),
  source                  TEXT NOT NULL DEFAULT 'mpi' CHECK (source IN ('mpi','advisor','maintenance_schedule')),
  title_i18n              JSONB NOT NULL DEFAULT '{}',
  description_i18n        JSONB NOT NULL DEFAULT '{}',
  line_item_ref           UUID,
  priority                TEXT NOT NULL DEFAULT 'p1' CHECK (priority IN ('p0','p1','p2')),
  status                  TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                            'proposed','sent_to_customer','accepted','declined','expired')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sr_ro ON service_recommendations (ro_id, status);

-- ──────────────────────────────────────────────────────────────
-- 4) EAS2 — Estimates & Authorizations
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ro_estimates (
  estimate_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  ro_id                   UUID NOT NULL REFERENCES repair_orders(ro_id),
  version                 INT NOT NULL DEFAULT 1,
  status                  TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                            'draft','sent','partially_approved','approved','declined','expired')),
  totals_ref              JSONB,
  language_mode           TEXT NOT NULL DEFAULT 'auto' CHECK (language_mode IN ('en','es','bilingual','auto')),
  sent_at                 TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Renamed from idx_roe_ro, which collided with the ro_events index of the same name.
-- Under CREATE INDEX IF NOT EXISTS the collision made this a silent no-op, leaving
-- ro_estimates with no secondary index at all.
CREATE INDEX IF NOT EXISTS idx_roest_ro ON ro_estimates (ro_id, status);
-- Estimate versions are assigned as MAX(version)+1 under a row lock on the repair
-- order; this constraint is the backstop against a duplicate version slipping through.
CREATE UNIQUE INDEX IF NOT EXISTS uq_roest_ro_version ON ro_estimates (ro_id, version);

CREATE TABLE IF NOT EXISTS ro_authorizations (
  authorization_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  ro_id                   UUID NOT NULL REFERENCES repair_orders(ro_id),
  estimate_id             UUID NOT NULL REFERENCES ro_estimates(estimate_id),
  method                  TEXT NOT NULL CHECK (method IN ('portal','signature','staff_attestation','recorded_call_ref')),
  status                  TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined','revoked')),
  approved_items          UUID[] NOT NULL DEFAULT '{}',
  declined_items          UUID[] NOT NULL DEFAULT '{}',
  evidence_refs           JSONB NOT NULL DEFAULT '{}',
  customer_language_used  TEXT DEFAULT 'en' CHECK (customer_language_used IN ('en','es')),
  authorized_at           TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_roa_ro       ON ro_authorizations (ro_id, status);
CREATE INDEX IF NOT EXISTS idx_roa_estimate ON ro_authorizations (estimate_id);

-- ──────────────────────────────────────────────────────────────
-- 5) POS2 — Parts Lines
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ro_parts_lines (
  part_line_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  ro_id                   UUID NOT NULL REFERENCES repair_orders(ro_id),
  line_item_id            UUID NOT NULL REFERENCES ro_line_items(line_item_id),
  part_number             TEXT NOT NULL,
  description             TEXT NOT NULL,
  quantity                NUMERIC NOT NULL DEFAULT 1 CHECK (quantity > 0),
  status                  TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
                            'requested','ordered','backordered','received','picked','installed','canceled')),
  eta                     TIMESTAMPTZ,
  supplier_ref            JSONB,
  cost_ref                JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rpl_ro     ON ro_parts_lines (ro_id, status);
CREATE INDEX IF NOT EXISTS idx_rpl_li     ON ro_parts_lines (line_item_id);

-- ──────────────────────────────────────────────────────────────
-- 6) SOS2 — Sublet Jobs
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS ro_sublet_jobs (
  sublet_job_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  ro_id                   UUID NOT NULL REFERENCES repair_orders(ro_id),
  line_item_id            UUID NOT NULL REFERENCES ro_line_items(line_item_id),
  vendor_ref              JSONB NOT NULL DEFAULT '{}',
  status                  TEXT NOT NULL DEFAULT 'requested' CHECK (status IN (
                            'requested','sent','in_progress','returned','verified','canceled')),
  expected_return_at      TIMESTAMPTZ,
  invoice_artifact_ref    TEXT,
  cost_ref                JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rsj_ro ON ro_sublet_jobs (ro_id, status);
CREATE INDEX IF NOT EXISTS idx_rsj_li ON ro_sublet_jobs (line_item_id);

-- ──────────────────────────────────────────────────────────────
-- 7) TDTS2 — Technician Profiles, Work Tickets, Time
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS tech_profiles (
  tech_profile_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  tech_user_id            UUID NOT NULL,
  location_id             UUID NOT NULL,
  skills                  TEXT[] NOT NULL DEFAULT '{}',
  certifications          TEXT[] NOT NULL DEFAULT '{}',
  status                  TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tp_tenant ON tech_profiles (tenant_id, location_id, status);
CREATE INDEX IF NOT EXISTS idx_tp_user   ON tech_profiles (tech_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tp_tenant_user_loc ON tech_profiles (tenant_id, tech_user_id, location_id);

CREATE TABLE IF NOT EXISTS tech_work_tickets (
  ticket_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  ro_id                   UUID NOT NULL REFERENCES repair_orders(ro_id),
  line_item_id            UUID NOT NULL REFERENCES ro_line_items(line_item_id),
  assigned_tech_user_id   UUID NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN (
                            'assigned','started','paused','completed','reassigned','canceled')),
  pause_reason            TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_twt_ro   ON tech_work_tickets (ro_id, status);
CREATE INDEX IF NOT EXISTS idx_twt_tech ON tech_work_tickets (assigned_tech_user_id, status);
CREATE INDEX IF NOT EXISTS idx_twt_li   ON tech_work_tickets (line_item_id);

CREATE TABLE IF NOT EXISTS tech_time_entries (
  time_entry_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  ticket_id               UUID NOT NULL REFERENCES tech_work_tickets(ticket_id),
  tech_user_id            UUID NOT NULL,
  event_type              TEXT NOT NULL CHECK (event_type IN ('start','pause','resume','stop')),
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tte_ticket ON tech_time_entries (ticket_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_tte_tech   ON tech_time_entries (tech_user_id, occurred_at DESC);

-- ──────────────────────────────────────────────────────────────
-- 8) WPCS2 + QCS2 — Warranty & Comebacks
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS warranty_claims (
  claim_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  ro_id                   UUID NOT NULL REFERENCES repair_orders(ro_id),
  status                  TEXT NOT NULL DEFAULT 'draft' CHECK (status IN (
                            'draft','submitted','approved','denied','paid','canceled')),
  evidence_refs           JSONB NOT NULL DEFAULT '{}',
  provider_ref            JSONB,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wc_ro ON warranty_claims (ro_id, status);

CREATE TABLE IF NOT EXISTS comeback_cases (
  comeback_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  original_ro_id          UUID NOT NULL REFERENCES repair_orders(ro_id),
  new_ro_id               UUID NOT NULL REFERENCES repair_orders(ro_id),
  root_cause_category     TEXT NOT NULL,
  reason_codes            TEXT[] NOT NULL DEFAULT '{}',
  severity                TEXT NOT NULL DEFAULT 'sev2' CHECK (severity IN ('sev0','sev1','sev2','sev3')),
  status                  TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','canceled')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT comeback_distinct_ros CHECK (original_ro_id <> new_ro_id)
);
CREATE INDEX IF NOT EXISTS idx_cc_tenant ON comeback_cases (tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_cc_orig   ON comeback_cases (original_ro_id);
CREATE INDEX IF NOT EXISTS idx_cc_new    ON comeback_cases (new_ro_id);

-- ──────────────────────────────────────────────────────────────
-- 9) SSR2 — Service Queue Items
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS service_queue_items (
  queue_item_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  location_id             UUID NOT NULL,
  queue_type              TEXT NOT NULL,
  ro_id                   UUID REFERENCES repair_orders(ro_id),
  appointment_id          UUID REFERENCES service_appointments(appointment_id),
  priority                TEXT NOT NULL DEFAULT 'p1' CHECK (priority IN ('p0','p1','p2')),
  status                  TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
                            'queued','in_progress','blocked','done','canceled')),
  assigned_to_user_id     UUID,
  sla_template_ref        UUID,
  sla_due_at              TIMESTAMPTZ,
  block_reason_codes      TEXT[],
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sqi_tenant_queue ON service_queue_items (tenant_id, queue_type, status);
CREATE INDEX IF NOT EXISTS idx_sqi_ro           ON service_queue_items (ro_id, status) WHERE ro_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sqi_appt         ON service_queue_items (appointment_id) WHERE appointment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sqi_sla          ON service_queue_items (sla_due_at) WHERE status IN ('queued','in_progress') AND sla_due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sqi_location     ON service_queue_items (tenant_id, location_id, queue_type, status);

-- ──────────────────────────────────────────────────────────────
-- 10) CSPP2 — Customer Service Portal Tasks
--
-- Owned by the service domain and keyed on ro_id. The original implementation
-- wrote customer-facing service tasks into the sales domain's deal_portal_tasks,
-- passing the repair-order id in the deal_id column.
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS service_portal_tasks (
  portal_task_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  ro_id                   UUID NOT NULL REFERENCES repair_orders(ro_id),
  task_type               TEXT NOT NULL CHECK (task_type IN (
                            'review_recommendations','review_and_sign','payment','pickup')),
  title_i18n              JSONB NOT NULL DEFAULT '{}',
  description_i18n        JSONB NOT NULL DEFAULT '{}',
  status                  TEXT NOT NULL DEFAULT 'created' CHECK (status IN (
                            'created','viewed','completed','expired','canceled')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_spt_ro     ON service_portal_tasks (ro_id, status);
CREATE INDEX IF NOT EXISTS idx_spt_tenant ON service_portal_tasks (tenant_id, status);

-- ============================================================
-- Total: 20 tables, 45 index statements (42 plain, 3 unique)
-- ============================================================
