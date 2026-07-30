-- ============================================================
-- Platform core — prerequisites shared by every domain module.
--
-- The Phase-248 bundle assumed `audit_events` already existed (it emits
-- `service.*` rows into it). This migration provides that table plus the
-- extension guard the phase migrations rely on.
-- ============================================================

-- gen_random_uuid() is built in from PostgreSQL 13. The extension keeps the
-- schema loadable on 12 and earlier, where it lives in pgcrypto.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ──────────────────────────────────────────────────────────────
-- Platform audit trail
--
-- Append-only. Written best-effort, outside the business transaction, so a
-- failure to audit never rolls back the work it describes (and never leaves an
-- aborted transaction behind).
-- ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS audit_events (
  event_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  event_type              TEXT NOT NULL,
  entity_type             TEXT NOT NULL,
  entity_id               UUID NOT NULL,
  actor_user_id           UUID,
  details                 JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ae_tenant_time ON audit_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ae_entity     ON audit_events (entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ae_actor      ON audit_events (actor_user_id, created_at DESC) WHERE actor_user_id IS NOT NULL;

-- ============================================================
-- Total: 1 table, 3 indexes
-- ============================================================
