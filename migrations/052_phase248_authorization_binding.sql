-- ============================================================
-- Phase 248 — Bind the customer's approval to what was approved
--
-- The authorization record proved that a customer approved *some line ids* against
-- an estimate, but nothing captured what those lines said at the moment of approval.
-- A later edit to a line's price or hours therefore changed what the customer was
-- charged with no trace, and the → authorized gate could not tell the difference.
--
-- Requires: 051_phase248_metrics_support.sql
-- ============================================================

-- ──────────────────────────────────────────────────────────────
-- 1) EAS2 — snapshot of the approved lines
--
-- Written once by recordAuthorization, never updated. Holds, per approved line:
-- description, labor_op_code, estimated_hours, sold_hours and price_ref exactly as
-- they stood when the customer decided. This is the evidence an invoice dispute is
-- settled against, and what the price-change guard compares to.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE ro_authorizations
  ADD COLUMN IF NOT EXISTS approved_snapshot JSONB NOT NULL DEFAULT '{}';

COMMENT ON COLUMN ro_authorizations.approved_snapshot IS
  'Immutable copy of each approved line item as it stood at the moment of decision. '
  'Keyed by line_item_id. Never updated after insert.';

-- ──────────────────────────────────────────────────────────────
-- 2) Commercial terms are frozen once the customer has approved
--
-- Enforced in the service layer (updateLineItem refuses the write), but stated here
-- too so the invariant survives a direct database change or a future code path that
-- forgets. A line whose authorization_status is 'approved' may still move through its
-- work statuses; its money may not move.
-- ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION forbid_approved_price_change() RETURNS TRIGGER AS $$
BEGIN
  IF OLD.authorization_status = 'approved' AND NEW.authorization_status = 'approved' THEN
    IF NEW.price_ref IS DISTINCT FROM OLD.price_ref THEN
      RAISE EXCEPTION 'price_ref cannot change on a customer-approved line item (line_item_id=%)', OLD.line_item_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.sold_hours IS DISTINCT FROM OLD.sold_hours THEN
      RAISE EXCEPTION 'sold_hours cannot change on a customer-approved line item (line_item_id=%)', OLD.line_item_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ro_line_items_price_freeze ON ro_line_items;
CREATE TRIGGER trg_ro_line_items_price_freeze
  BEFORE UPDATE ON ro_line_items
  FOR EACH ROW EXECUTE FUNCTION forbid_approved_price_change();

-- ============================================================
-- Total: 1 column, 1 function, 1 trigger
-- ============================================================
