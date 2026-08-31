-- ============================================================================
-- RELEASE TRAIN 4 — SALES PIPELINE AND SHOWROOM MANAGEMENT (FBL-100)
--
-- One train over the immutable 000–063 chain. It begins where Release Train 3
-- stopped: `lead_handoffs` is the seam, and an opportunity is created FROM one
-- rather than beside it, so the pipeline cannot start from thin air.
--
--   1. THE OPPORTUNITY — what sales owns after the handoff, who owns it, the
--      stage it is in, and the disposition it ends at.
--   2. THE SHOWROOM VISIT — arrival, greeting, the floor rotation that decides
--      who takes it, and the record of what happened while they were here.
--   3. VEHICLE SELECTION AND DEMONSTRATION — the cars under consideration and
--      the test drives actually taken, each against a real stock item.
--   4. FOLLOW-UP, NEGOTIATION AND MANAGER OVERSIGHT — the sales-side timeline,
--      the negotiation rounds, and the turnover that brings a manager in.
--   5. THE GRANTS the runtime role needs.
--   6. THE RESOURCE REGISTRY — both resolvers re-declared so an opportunity, a
--      visit and a demonstration resolve to the rooftop that owns them.
--   7. DENY-BY-DEFAULT ROW SECURITY over every table this train adds.
--
-- WHAT THIS TRAIN DELIBERATELY DOES NOT DO, so the omissions read as decisions:
--
--   * NO MONEY. Appraisal, trade, pricing and desking are FBL-120, and the
--     blueprint keeps them there. A negotiation here records that a round
--     happened, who asked, who was involved and how it ended — never a figure.
--     `negotiation_rounds` carries no amount column at all, which is a stronger
--     statement than a nullable one nobody fills in.
--   * NO DEAL RECORD, NO F&I, NO TITLE, NO DELIVERY. FBL-140 and FBL-160 own
--     those. A `sold` disposition here means the customer agreed to buy; it
--     does not mean a deal exists, and nothing in this train writes one.
--   * NO REVENUE. Migration 063's `ck_attribution_pre_sale_revenue` STAYS AS IT
--     IS. A sold opportunity is not a sale with a number attached — the number
--     arrives with desking in FBL-120 — so relaxing that constraint here would
--     trade one honest absence for an invented figure. Whoever writes FBL-120's
--     migration relaxes it, and they will have something real to put in it.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- Section 1 — THE OPPORTUNITY
-- ────────────────────────────────────────────────────────────────────────────

-- WHAT SALES OWNS. Created from a handoff, and one opportunity per handoff: the
-- CRM hands a lead over exactly once, so sales receives it exactly once.
CREATE TABLE opportunities (
  opportunity_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rooftop_id              UUID NOT NULL,
  party_id                UUID NOT NULL,
  -- THE SEAM. The handoff this opportunity came from, and the lead behind it.
  -- Both are recorded because the handoff is the EVENT and the lead is the
  -- history; an opportunity that named only one of them could not be traced
  -- back to the campaign that produced it.
  handoff_id              UUID NOT NULL,
  lead_id                 UUID NOT NULL,
  owner_user_link_id      UUID,
  stage                   TEXT NOT NULL DEFAULT 'received'
                            CHECK (stage IN ('received', 'in_showroom', 'demonstrated',
                                             'negotiating', 'won', 'lost')),
  -- Why it ended. Required exactly when it ended, so a close-rate report can be
  -- trusted rather than inferred.
  disposition             TEXT
                            CHECK (disposition IS NULL OR disposition IN (
                              'sold', 'lost_to_competitor', 'lost_no_decision',
                              'lost_credit', 'lost_no_vehicle', 'customer_unreachable')),
  -- A SOLD OPPORTUNITY IS NOT A DEAL. FBL-140 writes the deal record; this
  -- column says only that the customer agreed to buy, and the status below says
  -- plainly that the money is not here.
  deal_status             TEXT NOT NULL DEFAULT 'NOT_YET_AVAILABLE'
                            CHECK (deal_status IN ('NOT_YET_AVAILABLE', 'AVAILABLE')),
  won_at                  TIMESTAMPTZ,
  lost_at                 TIMESTAMPTZ,
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, opportunity_id),
  -- One opportunity per handoff. The CRM hands a lead over once; sales receives
  -- it once, and a retried creation converges rather than duplicating.
  UNIQUE (tenant_id, handoff_id),
  CHECK ((stage IN ('won', 'lost')) = (disposition IS NOT NULL)),
  CHECK (stage <> 'won' OR (won_at IS NOT NULL AND disposition = 'sold')),
  CHECK (stage <> 'lost' OR (lost_at IS NOT NULL AND disposition <> 'sold')),
  -- STRUCTURALLY PROHIBITED, exactly as migration 063 prohibits pre-sale
  -- revenue. FBL-140's migration relaxes this when a deal record exists to
  -- point at; until then an opportunity cannot claim one.
  CONSTRAINT ck_opportunity_pre_deal CHECK (deal_status = 'NOT_YET_AVAILABLE'),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, handoff_id) REFERENCES lead_handoffs (tenant_id, handoff_id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, lead_id),
  FOREIGN KEY (tenant_id, owner_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_opportunities_rooftop_stage ON opportunities (tenant_id, rooftop_id, stage);
CREATE INDEX idx_opportunities_owner
  ON opportunities (tenant_id, owner_user_link_id, stage)
  WHERE stage NOT IN ('won', 'lost');

-- EVERY STAGE MOVE, append-only. The opportunity carries where it is; this
-- carries the shape of the sales funnel, which a current-stage column cannot.
CREATE TABLE opportunity_stage_events (
  stage_event_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  opportunity_id          UUID NOT NULL,
  from_stage              TEXT NOT NULL,
  to_stage                TEXT NOT NULL,
  disposition             TEXT,
  note                    TEXT CHECK (note IS NULL OR length(note) <= 500),
  changed_by_user_link_id UUID NOT NULL,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, stage_event_id),
  CHECK (from_stage <> to_stage),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, opportunity_id),
  FOREIGN KEY (tenant_id, changed_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_opportunity_stage_events_opp
  ON opportunity_stage_events (tenant_id, opportunity_id, occurred_at);

-- WHO HAD IT, append-only. `opportunities.owner_user_link_id` is the current
-- answer; this is how it got there, which is what a commission dispute needs.
CREATE TABLE opportunity_assignments (
  assignment_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  opportunity_id          UUID NOT NULL,
  from_user_link_id       UUID,
  to_user_link_id         UUID NOT NULL,
  reason                  TEXT NOT NULL
                            CHECK (reason IN ('floor_rotation', 'manual_assignment',
                                              'reassignment', 'turnover', 'manager_override')),
  note                    TEXT CHECK (note IS NULL OR length(note) <= 500),
  assigned_by_user_link_id UUID NOT NULL,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, assignment_id),
  CHECK (from_user_link_id IS NULL OR from_user_link_id <> to_user_link_id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, opportunity_id),
  FOREIGN KEY (tenant_id, from_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, to_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, assigned_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_opportunity_assignments_opp
  ON opportunity_assignments (tenant_id, opportunity_id, occurred_at);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 2 — THE SHOWROOM VISIT AND THE FLOOR
-- ────────────────────────────────────────────────────────────────────────────

-- WHO IS UP NEXT. The floor rotation is the manager's instrument: it decides
-- which salesperson takes the next customer through the door, and it is a
-- record rather than a habit so a disputed turn has an answer.
CREATE TABLE floor_rotations (
  rotation_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rooftop_id              UUID NOT NULL,
  user_link_id            UUID NOT NULL,
  -- Where they sit in the queue. Lower goes first; the service keeps it dense.
  position                INTEGER NOT NULL CHECK (position >= 0),
  status                  TEXT NOT NULL DEFAULT 'available'
                            CHECK (status IN ('available', 'with_customer', 'unavailable')),
  last_taken_at           TIMESTAMPTZ,
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, rotation_id),
  -- One place in the rotation per person per rooftop.
  UNIQUE (tenant_id, rooftop_id, user_link_id),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_floor_rotations_queue
  ON floor_rotations (tenant_id, rooftop_id, position)
  WHERE status = 'available';

-- THE VISIT. Somebody walked in; this is what happened while they were here.
CREATE TABLE showroom_visits (
  visit_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rooftop_id              UUID NOT NULL,
  party_id                UUID NOT NULL,
  -- The opportunity this visit belongs to, when it belongs to one. A walk-in
  -- with no prior lead is a real visit, and forcing an opportunity first would
  -- make the platform refuse the most ordinary thing a showroom does.
  opportunity_id          UUID,
  -- The appointment kept, when the visit was booked. Release Train 3 owns
  -- appointments; this records that the customer turned up for one.
  appointment_id          UUID,
  greeted_by_user_link_id UUID,
  state                   TEXT NOT NULL DEFAULT 'arrived'
                            CHECK (state IN ('arrived', 'greeted', 'with_salesperson',
                                             'departed')),
  arrived_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  greeted_at              TIMESTAMPTZ,
  departed_at             TIMESTAMPTZ,
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, visit_id),
  -- One-way stamps: a visit that was greeted keeps the fact after it ends.
  CHECK (greeted_at IS NULL OR greeted_by_user_link_id IS NOT NULL),
  CHECK (state <> 'departed' OR departed_at IS NOT NULL),
  CHECK (state = 'arrived' OR greeted_at IS NOT NULL),
  CHECK (departed_at IS NULL OR departed_at >= arrived_at),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, opportunity_id),
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments (tenant_id, appointment_id),
  FOREIGN KEY (tenant_id, greeted_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
-- The board a manager watches: who is on the floor right now.
CREATE INDEX idx_showroom_visits_open
  ON showroom_visits (tenant_id, rooftop_id, arrived_at)
  WHERE state <> 'departed';

CREATE TABLE visit_events (
  visit_event_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  visit_id                UUID NOT NULL,
  event_type              TEXT NOT NULL
                            CHECK (event_type IN ('arrived', 'greeted', 'assigned',
                                                  'demonstration_started',
                                                  'demonstration_ended', 'turned_over',
                                                  'departed')),
  note                    TEXT CHECK (note IS NULL OR length(note) <= 500),
  actor_user_link_id      UUID NOT NULL,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, visit_event_id),
  FOREIGN KEY (tenant_id, visit_id) REFERENCES showroom_visits (tenant_id, visit_id),
  FOREIGN KEY (tenant_id, actor_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_visit_events_visit ON visit_events (tenant_id, visit_id, occurred_at);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 3 — VEHICLE SELECTION AND DEMONSTRATION
-- ────────────────────────────────────────────────────────────────────────────

-- THE CARS UNDER CONSIDERATION. Release Train 2 owns stock; this records which
-- of it a customer is actually looking at, and in what order of preference.
CREATE TABLE opportunity_vehicles (
  opportunity_vehicle_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  opportunity_id          UUID NOT NULL,
  stock_item_id           UUID NOT NULL,
  -- Preference order, dense and caller-supplied. Deliberately NOT unique: a
  -- salesperson reordering three cars would otherwise have to do it in an
  -- order the database happens to accept, which is a constraint serving the
  -- schema rather than the showroom.
  rank                    INTEGER NOT NULL DEFAULT 1 CHECK (rank >= 1),
  status                  TEXT NOT NULL DEFAULT 'considering'
                            CHECK (status IN ('considering', 'demonstrated', 'rejected',
                                              'selected')),
  rejected_reason         TEXT CHECK (rejected_reason IS NULL OR length(rejected_reason) <= 200),
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, opportunity_vehicle_id),
  -- One row per car per opportunity: adding the same car twice is a mistake,
  -- not a second interest.
  UNIQUE (tenant_id, opportunity_id, stock_item_id),
  CHECK (rejected_reason IS NULL OR status = 'rejected'),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, opportunity_id),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
-- ONE SELECTED CAR PER OPPORTUNITY. A customer buys one; two selected rows is
-- a state the showroom cannot be in.
CREATE UNIQUE INDEX uq_opportunity_vehicles_selected
  ON opportunity_vehicles (tenant_id, opportunity_id) WHERE status = 'selected';

-- THE TEST DRIVE. A real car, a real driver, and the licence check recorded as
-- a fact rather than assumed: a dealership that cannot show it checked is a
-- dealership that did not.
CREATE TABLE demonstrations (
  demonstration_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rooftop_id              UUID NOT NULL,
  opportunity_id          UUID NOT NULL,
  stock_item_id           UUID NOT NULL,
  visit_id                UUID,
  driver_party_id         UUID NOT NULL,
  accompanied_by_user_link_id UUID NOT NULL,
  licence_verified        BOOLEAN NOT NULL DEFAULT false,
  state                   TEXT NOT NULL DEFAULT 'in_progress'
                            CHECK (state IN ('in_progress', 'completed', 'abandoned')),
  outcome                 TEXT
                            CHECK (outcome IS NULL OR outcome IN ('interested', 'not_interested',
                                                                  'wants_alternative')),
  started_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at                TIMESTAMPTZ,
  notes                   TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, demonstration_id),
  -- A finished drive has an end and an answer; an abandoned one has an end and
  -- no answer, because nobody found out.
  CHECK (state <> 'completed' OR (ended_at IS NOT NULL AND outcome IS NOT NULL)),
  CHECK (state <> 'abandoned' OR ended_at IS NOT NULL),
  CHECK (state <> 'in_progress' OR (ended_at IS NULL AND outcome IS NULL)),
  CHECK (ended_at IS NULL OR ended_at >= started_at),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, opportunity_id),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, visit_id) REFERENCES showroom_visits (tenant_id, visit_id),
  FOREIGN KEY (tenant_id, driver_party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, accompanied_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
-- ONE CAR OUT AT A TIME. A stock item cannot be on two test drives at once,
-- and the partial index says so rather than a comment hoping somebody checks.
CREATE UNIQUE INDEX uq_demonstrations_vehicle_out
  ON demonstrations (tenant_id, stock_item_id) WHERE state = 'in_progress';
CREATE INDEX idx_demonstrations_opportunity
  ON demonstrations (tenant_id, opportunity_id, started_at);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 4 — FOLLOW-UP, NEGOTIATION AND MANAGER OVERSIGHT
-- ────────────────────────────────────────────────────────────────────────────

-- THE SALES-SIDE TIMELINE. Deliberately its own table rather than Release Train
-- 3's `lead_activities`: the CRM's timeline ends at the handoff, and writing
-- sales follow-up into it would make the frozen handoff snapshot a partial
-- account of a record still moving — the exact thing RT3-C1 closed.
CREATE TABLE opportunity_activities (
  activity_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  opportunity_id          UUID NOT NULL,
  kind                    TEXT NOT NULL
                            CHECK (kind IN ('note', 'call', 'email', 'sms', 'task',
                                            'appointment_followup')),
  direction               TEXT
                            CHECK (direction IS NULL OR direction IN ('inbound', 'outbound')),
  subject                 TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  body                    TEXT CHECK (body IS NULL OR length(body) <= 4000),
  state                   TEXT NOT NULL DEFAULT 'open'
                            CHECK (state IN ('open', 'completed', 'cancelled')),
  due_at                  TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, activity_id),
  CHECK ((kind IN ('call', 'email', 'sms')) = (direction IS NOT NULL)),
  CHECK (kind IN ('task', 'appointment_followup') OR due_at IS NULL),
  CHECK (state <> 'completed' OR completed_at IS NOT NULL),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, opportunity_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_opportunity_activities_opp
  ON opportunity_activities (tenant_id, opportunity_id, created_at);

-- THE NEGOTIATION, WITHOUT THE NUMBERS. Append-only rounds recording that a
-- round happened, who moved, whether a manager was brought in and how it ended.
--
-- THERE IS NO AMOUNT COLUMN, and that is the design. Pricing and desking are
-- FBL-120; a nullable `offer_cents` here would be filled in by somebody within
-- a week and the platform would be quoting figures it has no authority to
-- quote. `pricing_status` states the absence rather than leaving a reader to
-- assume the round was free.
CREATE TABLE negotiation_rounds (
  round_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  opportunity_id          UUID NOT NULL,
  round_number            INTEGER NOT NULL CHECK (round_number >= 1),
  initiated_by            TEXT NOT NULL CHECK (initiated_by IN ('customer', 'dealership')),
  summary                 TEXT NOT NULL CHECK (length(summary) BETWEEN 1 AND 1000),
  manager_involved        BOOLEAN NOT NULL DEFAULT false,
  outcome                 TEXT NOT NULL
                            CHECK (outcome IN ('countered', 'accepted', 'declined',
                                               'adjourned')),
  pricing_status          TEXT NOT NULL DEFAULT 'NOT_YET_AVAILABLE'
                            CHECK (pricing_status IN ('NOT_YET_AVAILABLE', 'AVAILABLE')),
  recorded_by_user_link_id UUID NOT NULL,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, round_id),
  -- Rounds are a sequence; the service assigns the number under a lock.
  UNIQUE (tenant_id, opportunity_id, round_number),
  -- FBL-120's migration relaxes this when desking exists to carry the figures.
  CONSTRAINT ck_negotiation_pre_desking CHECK (pricing_status = 'NOT_YET_AVAILABLE'),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, opportunity_id),
  FOREIGN KEY (tenant_id, recorded_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id)
);

-- THE DESK LOG. A turnover is the moment a salesperson brings a manager in, and
-- it is append-only because it is the record oversight is judged on.
CREATE TABLE manager_turnovers (
  turnover_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  opportunity_id          UUID NOT NULL,
  visit_id                UUID,
  requested_by_user_link_id UUID NOT NULL,
  manager_user_link_id    UUID NOT NULL,
  reason                  TEXT NOT NULL
                            CHECK (reason IN ('price_authority', 'customer_request',
                                              'second_voice', 'escalation', 'closing')),
  note                    TEXT CHECK (note IS NULL OR length(note) <= 500),
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, turnover_id),
  -- A salesperson cannot turn a customer over to themselves.
  CHECK (requested_by_user_link_id <> manager_user_link_id),
  FOREIGN KEY (tenant_id, opportunity_id) REFERENCES opportunities (tenant_id, opportunity_id),
  FOREIGN KEY (tenant_id, visit_id) REFERENCES showroom_visits (tenant_id, visit_id),
  FOREIGN KEY (tenant_id, requested_by_user_link_id)
    REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, manager_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_manager_turnovers_opp
  ON manager_turnovers (tenant_id, opportunity_id, occurred_at);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 5 — GRANTS
--
-- The same rule the earlier trains applied: the runtime may correct current
-- state and may only ADD to history. DELETE is granted to exactly one table —
-- a car a customer is no longer looking at is removed from the shortlist, and
-- a shortlist that can only grow is not a shortlist.
-- ────────────────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON
  opportunities, floor_rotations, showroom_visits, demonstrations, opportunity_activities
  TO dealership_runtime;

GRANT SELECT, INSERT ON
  opportunity_stage_events, opportunity_assignments, visit_events,
  negotiation_rounds, manager_turnovers
  TO dealership_runtime;

GRANT SELECT, INSERT, UPDATE, DELETE ON opportunity_vehicles TO dealership_runtime;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 6 — THE RESOURCE REGISTRY
--
-- Three new rooftop-owned resources: an opportunity, a showroom visit and a
-- demonstration. Everything hanging off them — stage moves, assignments,
-- vehicles, activities, negotiation rounds, turnovers — is authorized THROUGH
-- ITS PARENT, exactly as the earlier trains' children are.
--
-- BOTH resolvers are re-declared and must stay in step: migration 062 split
-- them by privilege — `resource_org_leaf` keeps the row-security bypass and is
-- executable only by `dealership_evidence_owner`, while
-- `resource_org_leaf_visible` is the ordinary lookup the engine calls.
-- `tests/architecture.test.ts` holds the two branch lists identical.
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
  -- No gate in this body, deliberately: who may bypass row security is decided
  -- by the GRANT below, not by anything a caller can write. See migration 062
  -- section 5 for why a predicate here was the wrong answer twice.
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
  END IF;
  RETURN leaf;
END;
$$ LANGUAGE plpgsql STABLE;

REVOKE ALL ON FUNCTION resource_org_leaf_visible(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resource_org_leaf_visible(text, uuid) TO dealership_runtime;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 7 — DENY-BY-DEFAULT ROW SECURITY
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE opportunities             ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_stage_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_assignments   ENABLE ROW LEVEL SECURITY;
ALTER TABLE floor_rotations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE showroom_visits           ENABLE ROW LEVEL SECURITY;
ALTER TABLE visit_events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_vehicles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE demonstrations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE opportunity_activities    ENABLE ROW LEVEL SECURITY;
ALTER TABLE negotiation_rounds        ENABLE ROW LEVEL SECURITY;
ALTER TABLE manager_turnovers         ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_opportunities_tenant ON opportunities
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_opportunity_stage_events_tenant ON opportunity_stage_events
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_opportunity_assignments_tenant ON opportunity_assignments
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_floor_rotations_tenant ON floor_rotations
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_showroom_visits_tenant ON showroom_visits
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_visit_events_tenant ON visit_events
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_opportunity_vehicles_tenant ON opportunity_vehicles
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_demonstrations_tenant ON demonstrations
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_opportunity_activities_tenant ON opportunity_activities
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_negotiation_rounds_tenant ON negotiation_rounds
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_manager_turnovers_tenant ON manager_turnovers
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
