-- ──────────────────────────────────────────────────────────────
-- Phase 248 — which lines an estimate actually asked about
--
-- `ro_estimates` recorded a version, a status and a `totals_ref` summary, but never which
-- line items it put in front of the customer. `generateEstimate` knows that population
-- exactly — it selects it — and then threw it away.
--
-- The consequence was in `recordAuthorization`. Deriving the estimate's status needs a
-- cumulative count (a customer who approves some lines now and the rest later must not
-- have the first approval erased by the second decision), so the count is taken from the
-- line items rather than from the decision being recorded. With no association to scope
-- it to, that count covered every line on the repair order:
--
--   * a supplemental estimate covering one new line was scored against the earlier
--     estimate's approvals and declines as well, and reported `partially_approved` when
--     its own single line had been approved outright;
--   * a line cancelled while still undecided counted as forever pending, so an estimate
--     whose every surviving line was approved could never reach `approved`.
--
-- Both are misreporting rather than a way past the authorization gate — the state machine
-- reads line-level `authorization_status`, not this column — but the estimate's status is
-- what an advisor reads off the cockpit, and what the customer-facing portal shows.
--
-- Nullable and unbackfilled on purpose. Estimates created before this migration have no
-- tagged lines, and `recordAuthorization` falls back to the previous repair-order-wide
-- count for them, so no existing row changes meaning.
-- ──────────────────────────────────────────────────────────────

ALTER TABLE ro_line_items
  ADD COLUMN IF NOT EXISTS estimate_id UUID REFERENCES ro_estimates(estimate_id);

COMMENT ON COLUMN ro_line_items.estimate_id IS
  'The most recent estimate that put this line to the customer. Set by generateEstimate. '
  'A re-quote moves the line to the newer version; only the current version may be '
  'decided, so the earlier association is not needed once it has been superseded.';

-- Supports the per-estimate tally in recordAuthorization.
CREATE INDEX IF NOT EXISTS idx_roli_estimate ON ro_line_items (estimate_id, authorization_status)
  WHERE estimate_id IS NOT NULL;
