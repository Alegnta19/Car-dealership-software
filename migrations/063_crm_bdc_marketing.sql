-- ============================================================================
-- RELEASE TRAIN 3 — CRM, BDC AND MARKETING (FBL-090 / 110)
--
-- One consolidated release over the accepted, immutable 000–062 chain. FBL-100
-- (sales and showroom) is deliberately NOT here: this train stops at the sales
-- handoff, and the handoff row is the seam it stops at.
--
--   1. SOURCES AND LEADS — where a lead came from, the lead itself, the
--      immutable touch history behind it, and the intake ledger that makes a
--      retried or concurrent capture converge on ONE lead rather than two.
--   2. ROUTING AND LIFECYCLE — queues, assignment history, status transitions,
--      the first-response clock, escalation, and the handoff that ends this
--      train's authority over the record.
--   3. ACTIVITY AND APPOINTMENTS — one shared timeline of tasks, notes,
--      communications and reminders, and the appointment with its own
--      reschedule/cancel history.
--   4. CONSENT AND SUPPRESSION — consent per CHANNEL and PURPOSE, and a
--      suppression list keyed on the contact value rather than the person, so
--      an opt-out survives the record it was made against.
--   5. CAMPAIGNS — a campaign, its frozen versions, the template and audience
--      each version froze, the sends, their delivery history and the replies
--      reconciled back into leads.
--   6. ATTRIBUTION — deterministic, versioned credit over the immutable
--      touches, carrying the revenue contract while reporting revenue as
--      NOT_YET_AVAILABLE, because no sale exists in this platform yet.
--   7. THE GRANTS the runtime role needs.
--   8. THE RESOURCE REGISTRY — both resolvers re-declared so a lead, an
--      appointment and a campaign resolve to the rooftop that owns them.
--   9. DENY-BY-DEFAULT ROW SECURITY over every table this train adds.
--
-- WHAT THIS TRAIN DELIBERATELY DOES NOT DO:
--
--   * NO SALE. There is no showroom visit, no appraisal, no desking, no deal,
--     no F&I, no delivery and no revenue. `lead_handoffs` records that a lead
--     was handed to sales and stops; nothing here reads a sale back.
--   * NO REVENUE FIGURE. Section 6 keeps the shape a revenue consumer will
--     need — a run, a model, a credited touch, a weight — and refuses to
--     invent the number. `revenue_status` is CHECK-constrained so that a row
--     claiming NOT_YET_AVAILABLE cannot also carry an amount, and no code path
--     in this train can write any other status. When Sales exists, the column
--     opens; until then the schema says "not yet" rather than "zero", because
--     zero is a measurement and this is an absence.
--   * NO CONTACT WITHOUT PERMISSION. Consent is opt-in per channel AND
--     purpose; absence is not permission. Suppression is rechecked AT SEND
--     TIME, not merely at audience time, because an opt-out that arrives
--     between building an audience and executing it is exactly the one that
--     matters.
-- ============================================================================

-- ────────────────────────────────────────────────────────────────────────────
-- Section 1 — SOURCES AND LEADS
-- ────────────────────────────────────────────────────────────────────────────

-- The dealership's own source catalog. A lead's source is a REFERENCE, not a
-- free-text label, because attribution that groups by typed strings is
-- attribution that silently splits "Autotrader" from "autotrader".
CREATE TABLE lead_sources (
  lead_source_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  source_code             TEXT NOT NULL CHECK (source_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  display_name            TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  -- How the lead arrived. `channel` is the mechanism, `medium` the paid/organic
  -- character; both are closed vocabularies so a report cannot be defeated by
  -- spelling.
  channel                 TEXT NOT NULL
                            CHECK (channel IN ('web', 'phone', 'walk_in', 'email',
                                               'sms', 'chat', 'marketplace', 'referral',
                                               'campaign', 'import', 'manual')),
  medium                  TEXT NOT NULL
                            CHECK (medium IN ('organic', 'paid', 'owned', 'referral',
                                              'direct', 'unknown')),
  status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'retired')),
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, lead_source_id),
  UNIQUE (tenant_id, source_code),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- THE LEAD. One customer's interest at one rooftop, owned by one employee at a
-- time, moving through a lifecycle that ends either closed or handed to sales.
CREATE TABLE leads (
  lead_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  -- The rooftop that owns the lead. This is what `resource_org_leaf` resolves,
  -- so it is what decides which employees can see it at all.
  rooftop_id              UUID NOT NULL,
  -- The canonical customer. Release Train 2 owns party identity; this train
  -- does not invent a second one, and a lead cannot exist without a party.
  party_id                UUID NOT NULL,
  -- What they are interested in, if anything specific. A stock item is a
  -- particular car on the lot; a vehicle is a model interest with no unit
  -- chosen yet. Both are optional and mutually exclusive.
  interest_stock_item_id  UUID,
  interest_vehicle_id     UUID,
  -- The de-duplication key, DERIVED so no caller can shape it. Two open leads
  -- for one customer at one rooftop about the same thing are one lead; two
  -- about different cars are genuinely two.
  interest_key            TEXT NOT NULL
                            GENERATED ALWAYS AS (
                              COALESCE(interest_stock_item_id::text,
                                       interest_vehicle_id::text,
                                       'general')
                            ) STORED,
  lifecycle_state         TEXT NOT NULL DEFAULT 'new'
                            CHECK (lifecycle_state IN ('new', 'working', 'qualified',
                                                       'appointment_set', 'handed_off',
                                                       'closed')),
  -- Why it ended. Required exactly when it ended, which is the only way a
  -- disposition report can be trusted.
  disposition             TEXT
                            CHECK (disposition IS NULL OR disposition IN (
                              'sold_elsewhere', 'not_interested', 'unqualified',
                              'duplicate', 'no_contact', 'handed_to_sales')),
  owner_user_link_id      UUID,
  queue_id                UUID,
  primary_source_id       UUID NOT NULL,
  -- The first-response clock. `first_response_at` is stamped ONCE by the
  -- service on the first outbound activity and never reset — a lead that was
  -- answered late is not repaired by answering it again.
  -- TWO DEADLINES, BECAUSE THEY MEAN TWO DIFFERENT THINGS. The response target
  -- is when the dealership has broken its own promise to the customer; the
  -- escalation threshold is when a manager should be told. `lead_sla_policies`
  -- has always carried both numbers, and escalating at the response target
  -- would make the second column decorative — a policy field nothing reads is
  -- a policy field that lies.
  first_response_due_at   TIMESTAMPTZ,
  escalate_at             TIMESTAMPTZ,
  first_response_at       TIMESTAMPTZ,
  escalated_at            TIMESTAMPTZ,
  handed_off_at           TIMESTAMPTZ,
  closed_at               TIMESTAMPTZ,
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, lead_id),
  -- A lead is interested in a specific car OR a model, never both.
  CHECK (interest_stock_item_id IS NULL OR interest_vehicle_id IS NULL),
  -- Terminal states carry their instant, and only terminal states do. One-way,
  -- so a lead that WAS handed off keeps the fact after it closes.
  CHECK (lifecycle_state <> 'handed_off' OR handed_off_at IS NOT NULL),
  CHECK (lifecycle_state <> 'closed' OR closed_at IS NOT NULL),
  CHECK ((lifecycle_state IN ('handed_off', 'closed')) = (disposition IS NOT NULL)),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, interest_stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, interest_vehicle_id) REFERENCES vehicles (tenant_id, vehicle_id),
  FOREIGN KEY (tenant_id, primary_source_id) REFERENCES lead_sources (tenant_id, lead_source_id),
  FOREIGN KEY (tenant_id, owner_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- ONE OPEN LEAD PER CUSTOMER, PER ROOFTOP, PER INTEREST — and no more than
-- that. The index is partial on the OPEN states, so a customer who bought
-- elsewhere last year and comes back is a new lead rather than an error, and
-- two open interests in two different cars are two leads rather than a
-- collision. The service decides under an advisory lock before it writes; this
-- is what makes the decision TRUE rather than likely when two intakes race.
CREATE UNIQUE INDEX uq_leads_open_interest
  ON leads (tenant_id, rooftop_id, party_id, interest_key)
  WHERE lifecycle_state NOT IN ('handed_off', 'closed');
CREATE INDEX idx_leads_owner ON leads (tenant_id, owner_user_link_id, lifecycle_state);
CREATE INDEX idx_leads_queue ON leads (tenant_id, queue_id) WHERE queue_id IS NOT NULL;
CREATE INDEX idx_leads_rooftop_state ON leads (tenant_id, rooftop_id, lifecycle_state);
-- The overdue query the SLA sweep runs: unanswered leads whose clock has run out.
CREATE INDEX idx_leads_first_response_due
  ON leads (tenant_id, first_response_due_at)
  WHERE first_response_at IS NULL AND lifecycle_state NOT IN ('handed_off', 'closed');
-- The query the escalation sweep actually runs.
CREATE INDEX idx_leads_escalate_at
  ON leads (tenant_id, escalate_at)
  WHERE first_response_at IS NULL AND escalated_at IS NULL
    AND lifecycle_state NOT IN ('handed_off', 'closed');

-- THE INTAKE LEDGER, append-only. Every capture attempt is recorded with what
-- it decided, INCLUDING the ones that found an existing lead — a retried
-- webhook and a double-submitted form are normal, and an intake log that only
-- shows successes cannot tell you that.
CREATE TABLE lead_intakes (
  intake_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  -- The caller's own idempotency handle for this capture. Two deliveries of one
  -- provider event carry one key and converge on one row.
  intake_key              TEXT NOT NULL CHECK (length(intake_key) BETWEEN 1 AND 200),
  channel                 TEXT NOT NULL
                            CHECK (channel IN ('manual', 'import', 'campaign', 'website',
                                               'provider')),
  lead_id                 UUID,
  outcome                 TEXT NOT NULL
                            CHECK (outcome IN ('created', 'merged_into_existing', 'rejected')),
  -- Why a rejection was a rejection. Present exactly when it was one.
  reason                  TEXT CHECK (reason IS NULL OR length(reason) <= 200),
  -- The payload's shape, never the payload. A raw lead body carries a person's
  -- contact details and free text; the fingerprint is enough to recognise a
  -- replay and carries none of it.
  payload_fingerprint     TEXT NOT NULL CHECK (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  received_by_user_link_id UUID NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, intake_id),
  UNIQUE (tenant_id, intake_key),
  CHECK ((outcome = 'rejected') = (lead_id IS NULL)),
  CHECK ((outcome = 'rejected') = (reason IS NOT NULL)),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, lead_id),
  FOREIGN KEY (tenant_id, received_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- THE SOURCE HISTORY, append-only and immutable. This is the evidence
-- attribution runs over, so it is the one table in this train that must never
-- be corrected in place: a touch that can be edited afterwards is a touch that
-- can be edited to change last quarter's numbers.
CREATE TABLE lead_source_touches (
  touch_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  lead_id                 UUID NOT NULL,
  lead_source_id          UUID NOT NULL,
  -- The campaign version this touch came from, when it came from one at all.
  campaign_version_id     UUID,
  -- Position in this lead's history. Assigned by trigger, never by the caller,
  -- because attribution ORDERS BY it and a caller-chosen sequence is a
  -- caller-chosen answer.
  touch_seq               INTEGER NOT NULL,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  detail                  JSONB NOT NULL DEFAULT '{}',
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, touch_id),
  UNIQUE (tenant_id, lead_id, touch_seq),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, lead_id),
  FOREIGN KEY (tenant_id, lead_source_id) REFERENCES lead_sources (tenant_id, lead_source_id)
);
CREATE INDEX idx_lead_source_touches_lead ON lead_source_touches (tenant_id, lead_id, touch_seq);

CREATE OR REPLACE FUNCTION crm_touch_seq_is_derived()
RETURNS trigger
SET search_path = public, pg_temp
AS $$
BEGIN
  -- The next position for this lead, taken while the row is being written. Any
  -- value the caller supplied is discarded rather than validated: there is no
  -- legitimate reason to choose your own place in a history.
  SELECT COALESCE(MAX(t.touch_seq), 0) + 1 INTO NEW.touch_seq
    FROM lead_source_touches t
   WHERE t.tenant_id = NEW.tenant_id AND t.lead_id = NEW.lead_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_lead_source_touches_seq_derived
  BEFORE INSERT ON lead_source_touches
  FOR EACH ROW EXECUTE FUNCTION crm_touch_seq_is_derived();

-- ────────────────────────────────────────────────────────────────────────────
-- Section 2 — ROUTING AND LIFECYCLE
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE lead_queues (
  queue_id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rooftop_id              UUID NOT NULL,
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'retired')),
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, queue_id),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
-- One live queue name per rooftop; a retired queue frees its name.
CREATE UNIQUE INDEX uq_lead_queues_live_name
  ON lead_queues (tenant_id, rooftop_id, lower(name)) WHERE status = 'active';

ALTER TABLE leads
  ADD FOREIGN KEY (tenant_id, queue_id) REFERENCES lead_queues (tenant_id, queue_id);

-- WHO OWNED IT, WHEN, AND WHY IT MOVED — append-only. `leads.owner_user_link_id`
-- is the current answer; this is how it got there, which is what a
-- reassignment dispute actually needs.
CREATE TABLE lead_assignments (
  assignment_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  lead_id                 UUID NOT NULL,
  from_user_link_id       UUID,
  to_user_link_id         UUID,
  queue_id                UUID,
  reason                  TEXT NOT NULL
                            CHECK (reason IN ('initial_routing', 'manual_assignment',
                                              'reassignment', 'escalation', 'queue_return')),
  note                    TEXT CHECK (note IS NULL OR length(note) <= 500),
  assigned_by_user_link_id UUID NOT NULL,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, assignment_id),
  -- An assignment that moves nothing is not an assignment.
  CHECK (to_user_link_id IS NOT NULL OR queue_id IS NOT NULL),
  CHECK (from_user_link_id IS NULL OR from_user_link_id <> to_user_link_id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, lead_id),
  FOREIGN KEY (tenant_id, queue_id) REFERENCES lead_queues (tenant_id, queue_id),
  FOREIGN KEY (tenant_id, from_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, to_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, assigned_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_lead_assignments_lead ON lead_assignments (tenant_id, lead_id, occurred_at);

-- EVERY LIFECYCLE MOVE, append-only. The lead carries its current state; this
-- carries the shape of the funnel, which a current-state column cannot.
CREATE TABLE lead_status_events (
  status_event_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  lead_id                 UUID NOT NULL,
  from_state              TEXT NOT NULL,
  to_state                TEXT NOT NULL,
  disposition             TEXT,
  note                    TEXT CHECK (note IS NULL OR length(note) <= 500),
  changed_by_user_link_id UUID NOT NULL,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, status_event_id),
  CHECK (from_state <> to_state),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, lead_id),
  FOREIGN KEY (tenant_id, changed_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_lead_status_events_lead ON lead_status_events (tenant_id, lead_id, occurred_at);

-- HOW LONG THE DEALERSHIP GIVES ITSELF TO ANSWER. One live policy per rooftop.
CREATE TABLE lead_sla_policies (
  sla_policy_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rooftop_id              UUID NOT NULL,
  first_response_minutes  INTEGER NOT NULL
                            CHECK (first_response_minutes BETWEEN 1 AND 10080),
  escalate_after_minutes  INTEGER NOT NULL
                            CHECK (escalate_after_minutes BETWEEN 1 AND 20160),
  status                  TEXT NOT NULL DEFAULT 'active'
                            CHECK (status IN ('active', 'superseded')),
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, sla_policy_id),
  -- Escalation cannot precede the response it escalates.
  CHECK (escalate_after_minutes >= first_response_minutes),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE UNIQUE INDEX uq_lead_sla_policies_live
  ON lead_sla_policies (tenant_id, rooftop_id) WHERE status = 'active';

-- AN UNANSWERED LEAD, RAISED. Append-only, and at most one open escalation per
-- lead per level so a sweep that runs twice does not raise the same alarm
-- twice.
CREATE TABLE lead_escalations (
  escalation_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  lead_id                 UUID NOT NULL,
  level                   TEXT NOT NULL CHECK (level IN ('first_response', 'no_contact')),
  due_at                  TIMESTAMPTZ NOT NULL,
  raised_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raised_by               TEXT NOT NULL DEFAULT 'system'
                            CHECK (raised_by IN ('system', 'manager')),
  UNIQUE (tenant_id, escalation_id),
  UNIQUE (tenant_id, lead_id, level),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, lead_id)
);

-- THE SEAM. A handoff is where this train's authority ends: sales owns what
-- happens next, and nothing in Release Train 3 may write past this row. It is
-- append-only and one per lead, so "handed off twice" is not representable.
CREATE TABLE lead_handoffs (
  handoff_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  lead_id                 UUID NOT NULL,
  -- A snapshot of what sales is being handed, frozen at the instant of the
  -- handoff. Sales does not exist yet; when it does, it reads this, not the
  -- live lead, so a later CRM edit cannot rewrite what was handed over.
  handed_snapshot         JSONB NOT NULL,
  handed_to_user_link_id  UUID NOT NULL,
  handed_by_user_link_id  UUID NOT NULL,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, handoff_id),
  UNIQUE (tenant_id, lead_id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, lead_id),
  FOREIGN KEY (tenant_id, handed_to_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, handed_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 3 — ACTIVITY AND APPOINTMENTS
-- ────────────────────────────────────────────────────────────────────────────

-- ONE TIMELINE. A task, a note, a call, an email and a reminder are the same
-- kind of thing to the person reading a lead's history — something that
-- happened, or is due to — so they are one table rather than five that have to
-- be merged in the query and can disagree about ordering.
CREATE TABLE lead_activities (
  activity_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  lead_id                 UUID NOT NULL,
  kind                    TEXT NOT NULL
                            CHECK (kind IN ('task', 'note', 'call', 'email', 'sms',
                                            'reminder')),
  direction               TEXT
                            CHECK (direction IS NULL OR direction IN ('inbound', 'outbound')),
  subject                 TEXT NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  body                    TEXT CHECK (body IS NULL OR length(body) <= 4000),
  state                   TEXT NOT NULL DEFAULT 'open'
                            CHECK (state IN ('open', 'completed', 'cancelled')),
  due_at                  TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  assigned_to_user_link_id UUID,
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, activity_id),
  -- A communication has a direction; a note does not.
  CHECK ((kind IN ('call', 'email', 'sms')) = (direction IS NOT NULL)),
  -- Something that can be due has a due date; a note cannot be overdue.
  CHECK (kind IN ('task', 'reminder') OR due_at IS NULL),
  -- One-way: completion carries its instant, and a reopened item is a new one.
  CHECK (state <> 'completed' OR completed_at IS NOT NULL),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, lead_id),
  FOREIGN KEY (tenant_id, assigned_to_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_lead_activities_lead ON lead_activities (tenant_id, lead_id, created_at);
CREATE INDEX idx_lead_activities_due
  ON lead_activities (tenant_id, due_at)
  WHERE state = 'open' AND due_at IS NOT NULL;

-- THE APPOINTMENT. Its own resource, because a rooftop-bound employee's reach
-- over an appointment is decided the same way as over a lead, and because a
-- reschedule must not lose the original.
CREATE TABLE appointments (
  appointment_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rooftop_id              UUID NOT NULL,
  lead_id                 UUID NOT NULL,
  party_id                UUID NOT NULL,
  stock_item_id           UUID,
  purpose                 TEXT NOT NULL
                            CHECK (purpose IN ('test_drive', 'showroom_visit', 'consultation',
                                               'delivery_preview', 'callback')),
  starts_at               TIMESTAMPTZ NOT NULL,
  ends_at                 TIMESTAMPTZ NOT NULL,
  state                   TEXT NOT NULL DEFAULT 'scheduled'
                            CHECK (state IN ('scheduled', 'confirmed', 'completed',
                                             'cancelled', 'no_show')),
  cancelled_reason        TEXT CHECK (cancelled_reason IS NULL OR length(cancelled_reason) <= 200),
  cancelled_at            TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  -- How many times it has moved. Derived by trigger from the event history so
  -- it cannot drift from it.
  reschedule_count        INTEGER NOT NULL DEFAULT 0 CHECK (reschedule_count >= 0),
  assigned_to_user_link_id UUID,
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, appointment_id),
  CHECK (ends_at > starts_at),
  CHECK (state <> 'cancelled' OR cancelled_at IS NOT NULL),
  CHECK (state <> 'completed' OR completed_at IS NOT NULL),
  CHECK (cancelled_reason IS NULL OR state = 'cancelled'),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, lead_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_items (tenant_id, stock_item_id),
  FOREIGN KEY (tenant_id, assigned_to_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_appointments_lead ON appointments (tenant_id, lead_id);
CREATE INDEX idx_appointments_calendar
  ON appointments (tenant_id, rooftop_id, starts_at)
  WHERE state IN ('scheduled', 'confirmed');

-- WHAT HAPPENED TO IT, append-only. A reschedule keeps both times, so "we moved
-- your appointment" is answerable a month later.
CREATE TABLE appointment_events (
  appointment_event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  appointment_id          UUID NOT NULL,
  event_type              TEXT NOT NULL
                            CHECK (event_type IN ('scheduled', 'confirmed', 'rescheduled',
                                                  'cancelled', 'completed', 'no_show')),
  from_starts_at          TIMESTAMPTZ,
  to_starts_at            TIMESTAMPTZ,
  note                    TEXT CHECK (note IS NULL OR length(note) <= 500),
  actor_user_link_id      UUID NOT NULL,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, appointment_event_id),
  -- A reschedule states both ends of the move; nothing else may.
  CHECK ((event_type = 'rescheduled') = (from_starts_at IS NOT NULL AND to_starts_at IS NOT NULL)),
  FOREIGN KEY (tenant_id, appointment_id) REFERENCES appointments (tenant_id, appointment_id),
  FOREIGN KEY (tenant_id, actor_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_appointment_events_appt
  ON appointment_events (tenant_id, appointment_id, occurred_at);

CREATE OR REPLACE FUNCTION crm_reschedule_count_is_derived()
RETURNS trigger
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.event_type = 'rescheduled' THEN
    UPDATE appointments a
       SET reschedule_count = (
             SELECT COUNT(*) FROM appointment_events e
              WHERE e.tenant_id = NEW.tenant_id
                AND e.appointment_id = NEW.appointment_id
                AND e.event_type = 'rescheduled')
     WHERE a.tenant_id = NEW.tenant_id AND a.appointment_id = NEW.appointment_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_appointment_events_count_derived
  AFTER INSERT ON appointment_events
  FOR EACH ROW EXECUTE FUNCTION crm_reschedule_count_is_derived();

-- ────────────────────────────────────────────────────────────────────────────
-- Section 4 — CONSENT AND SUPPRESSION
--
-- Migration 062 recorded consent per CHANNEL. Marketing needs it per channel
-- AND PURPOSE: a customer who agreed to service reminders has not agreed to
-- sales promotions, and a platform that cannot express that difference will
-- eventually send the second under the authority of the first. 062's table is
-- accepted and immutable, so the purpose dimension is added beside it rather
-- than folded into it.
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE party_purpose_consents (
  tenant_id               UUID NOT NULL,
  party_id                UUID NOT NULL,
  channel                 TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'phone', 'postal')),
  purpose                 TEXT NOT NULL
                            CHECK (purpose IN ('sales_marketing', 'service_reminder',
                                               'transactional', 'research')),
  state                   TEXT NOT NULL CHECK (state IN ('granted', 'withdrawn', 'unknown')),
  source                  TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 100),
  captured_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, party_id, channel, purpose),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- SUPPRESSION IS KEYED ON THE CONTACT VALUE, NOT THE PERSON. An unsubscribe is
-- a statement about an address: if the record it was made against is merged,
-- archived or recreated, the address is still opted out. Keying it to a party
-- would let a new record for the same person quietly restore contact.
CREATE TABLE contact_suppressions (
  suppression_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  contact_kind            TEXT NOT NULL CHECK (contact_kind IN ('email', 'phone')),
  -- Normalized by the service the same way `parties` normalizes, so a
  -- suppression written from a form matches a send addressed from a record.
  contact_value           TEXT NOT NULL CHECK (length(contact_value) BETWEEN 3 AND 320),
  reason                  TEXT NOT NULL
                            CHECK (reason IN ('unsubscribe', 'complaint', 'bounce',
                                              'do_not_contact', 'manual')),
  -- The party it was recorded against, when one was known. Informational: the
  -- value above is what suppresses.
  party_id                UUID,
  state                   TEXT NOT NULL DEFAULT 'active'
                            CHECK (state IN ('active', 'lifted')),
  lifted_reason           TEXT CHECK (lifted_reason IS NULL OR length(lifted_reason) <= 200),
  lifted_at               TIMESTAMPTZ,
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, suppression_id),
  CHECK (state <> 'lifted' OR (lifted_at IS NOT NULL AND lifted_reason IS NOT NULL)),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE UNIQUE INDEX uq_contact_suppressions_active
  ON contact_suppressions (tenant_id, contact_kind, contact_value) WHERE state = 'active';

-- ────────────────────────────────────────────────────────────────────────────
-- Section 5 — CAMPAIGNS
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE campaigns (
  campaign_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rooftop_id              UUID NOT NULL,
  name                    TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  channel                 TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  purpose                 TEXT NOT NULL
                            CHECK (purpose IN ('sales_marketing', 'service_reminder',
                                               'research')),
  lead_source_id          UUID NOT NULL,
  -- QUIET HOURS, as minutes since local midnight, plus the zone they are
  -- measured in. A window that wraps midnight is normal and is handled by the
  -- service rather than forbidden here.
  quiet_hours_start_minute INTEGER NOT NULL DEFAULT 1260
                            CHECK (quiet_hours_start_minute BETWEEN 0 AND 1439),
  quiet_hours_end_minute  INTEGER NOT NULL DEFAULT 480
                            CHECK (quiet_hours_end_minute BETWEEN 0 AND 1439),
  time_zone               TEXT NOT NULL DEFAULT 'UTC'
                            CHECK (length(time_zone) BETWEEN 1 AND 64),
  status                  TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'active', 'archived')),
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, campaign_id),
  -- A transactional campaign is a contradiction: transactional messages are not
  -- campaigns, and allowing the purpose here would let marketing borrow the one
  -- consent class customers cannot refuse.
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, lead_source_id) REFERENCES lead_sources (tenant_id, lead_source_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE UNIQUE INDEX uq_campaigns_live_name
  ON campaigns (tenant_id, rooftop_id, lower(name)) WHERE status <> 'archived';

-- A VERSION IS WHAT ACTUALLY RUNS. The campaign is the ongoing idea; the
-- version is the frozen decision — this audience, this template, approved by
-- this person, at this moment. Editing a campaign never changes what a past
-- version sent, because a past version's audience and template are their own
-- rows.
CREATE TABLE campaign_versions (
  campaign_version_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  campaign_id             UUID NOT NULL,
  version_number          INTEGER NOT NULL CHECK (version_number >= 1),
  state                   TEXT NOT NULL DEFAULT 'draft'
                            CHECK (state IN ('draft', 'approved', 'executing',
                                             'completed', 'cancelled')),
  approved_by_user_link_id UUID,
  approved_at             TIMESTAMPTZ,
  execution_started_at    TIMESTAMPTZ,
  completed_at            TIMESTAMPTZ,
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, campaign_version_id),
  UNIQUE (tenant_id, campaign_id, version_number),
  -- Approval is a person and an instant, together or not at all, and it is
  -- one-way: a version that ran keeps its approval after it completes.
  CHECK ((approved_by_user_link_id IS NULL) = (approved_at IS NULL)),
  CHECK (state = 'draft' OR state = 'cancelled' OR approved_at IS NOT NULL),
  CHECK (state <> 'completed' OR completed_at IS NOT NULL),
  FOREIGN KEY (tenant_id, campaign_id) REFERENCES campaigns (tenant_id, campaign_id),
  FOREIGN KEY (tenant_id, approved_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
-- Only one version of a campaign may be running at a time; a second would
-- double-send to an overlapping audience.
CREATE UNIQUE INDEX uq_campaign_versions_executing
  ON campaign_versions (tenant_id, campaign_id) WHERE state = 'executing';

ALTER TABLE lead_source_touches
  ADD FOREIGN KEY (tenant_id, campaign_version_id)
    REFERENCES campaign_versions (tenant_id, campaign_version_id);

-- The message a version froze. Append-only: a template that can be edited after
-- a send is a template nobody can produce for a complaint.
CREATE TABLE campaign_templates (
  template_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  campaign_version_id     UUID NOT NULL,
  subject                 TEXT CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 200),
  body                    TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000),
  -- The unsubscribe affordance the body carries. Required for marketing, and
  -- checked by the service before a version may be approved.
  includes_opt_out        BOOLEAN NOT NULL DEFAULT true,
  created_by_user_link_id UUID NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, template_id),
  UNIQUE (tenant_id, campaign_version_id),
  FOREIGN KEY (tenant_id, campaign_version_id)
    REFERENCES campaign_versions (tenant_id, campaign_version_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);

-- The audience a version froze, resolved to actual people. Append-only, because
-- "who did we send to" must not change when the underlying customer records do.
CREATE TABLE campaign_audience_members (
  audience_member_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  campaign_version_id     UUID NOT NULL,
  party_id                UUID NOT NULL,
  -- Why they were included, so an audience can be explained rather than
  -- merely listed.
  included_because        TEXT NOT NULL
                            CHECK (included_because IN ('all_active_customers',
                                                        'open_leads', 'prior_buyers',
                                                        'manual_selection')),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, audience_member_id),
  UNIQUE (tenant_id, campaign_version_id, party_id),
  FOREIGN KEY (tenant_id, campaign_version_id)
    REFERENCES campaign_versions (tenant_id, campaign_version_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, party_id)
);

-- ONE SEND PER PERSON PER VERSION. The state machine here is the whole of
-- row 4's safety: a send that was suppressed says so and why, a send that was
-- held for quiet hours says so and when it may go, and neither is a failure.
CREATE TABLE campaign_sends (
  send_id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  campaign_version_id     UUID NOT NULL,
  party_id                UUID NOT NULL,
  channel                 TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  -- The address as it stood when the send was prepared. Kept because a
  -- complaint is about what was contacted, not about the record's value today.
  contact_value           TEXT NOT NULL CHECK (length(contact_value) BETWEEN 3 AND 320),
  state                   TEXT NOT NULL DEFAULT 'pending'
                            CHECK (state IN ('pending', 'sent', 'failed',
                                             'suppressed', 'deferred_quiet_hours')),
  -- Why it did not go. Present exactly when it did not.
  -- Each refusal names its OWN reason. An archived or merged customer is not a
  -- customer with no email address, and reporting one as the other sends a
  -- marketer looking for a data-quality problem that does not exist.
  withheld_reason         TEXT
                            CHECK (withheld_reason IS NULL OR withheld_reason IN (
                              'suppressed_contact', 'consent_not_granted',
                              'quiet_hours', 'no_contact_value', 'party_inactive')),
  attempts                INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  external_ref            TEXT CHECK (external_ref IS NULL OR length(external_ref) BETWEEN 1 AND 100),
  last_error              TEXT CHECK (last_error IS NULL OR length(last_error) <= 500),
  available_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at                 TIMESTAMPTZ,
  created_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, send_id),
  UNIQUE (tenant_id, campaign_version_id, party_id),
  CHECK (state <> 'sent' OR sent_at IS NOT NULL),
  CHECK ((state IN ('suppressed', 'deferred_quiet_hours')) = (withheld_reason IS NOT NULL)),
  -- A message that was never sent has no provider reference to show.
  CHECK (external_ref IS NULL OR state = 'sent'),
  FOREIGN KEY (tenant_id, campaign_version_id)
    REFERENCES campaign_versions (tenant_id, campaign_version_id),
  FOREIGN KEY (tenant_id, party_id) REFERENCES parties (tenant_id, party_id),
  FOREIGN KEY (tenant_id, created_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE INDEX idx_campaign_sends_due
  ON campaign_sends (tenant_id, available_at)
  WHERE state IN ('pending', 'deferred_quiet_hours');
CREATE INDEX idx_campaign_sends_version ON campaign_sends (tenant_id, campaign_version_id, state);

-- EVERY ATTEMPT AND EVERY ANSWER, append-only, one row per attempt per kind —
-- so a replayed delivery trying to write a second 'sent' for attempt 1 is
-- refused by the database and recognised as the replay it is.
CREATE TABLE campaign_send_events (
  send_event_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  send_id                 UUID NOT NULL,
  event_type              TEXT NOT NULL
                            CHECK (event_type IN ('requested', 'sent', 'failed',
                                                  'suppressed', 'deferred', 'reconciled')),
  attempt                 INTEGER NOT NULL CHECK (attempt >= 0),
  detail                  TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  external_ref            TEXT CHECK (external_ref IS NULL OR length(external_ref) BETWEEN 1 AND 100),
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, send_event_id),
  UNIQUE (tenant_id, send_id, event_type, attempt),
  FOREIGN KEY (tenant_id, send_id) REFERENCES campaign_sends (tenant_id, send_id)
);

-- A REPLY. It is the point of the whole section: a response reconciled into a
-- lead is how a campaign becomes pipeline rather than activity.
CREATE TABLE campaign_responses (
  response_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  send_id                 UUID NOT NULL,
  response_type           TEXT NOT NULL
                            CHECK (response_type IN ('reply', 'click', 'opt_out', 'bounce')),
  -- The lead this response produced or advanced, when it produced one. An
  -- opt-out and a bounce produce no lead, and saying so is the point.
  lead_id                 UUID,
  detail                  TEXT CHECK (detail IS NULL OR length(detail) <= 500),
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, response_id),
  -- One response of a kind per send: a provider redelivering "opted out" does
  -- not opt the customer out twice.
  UNIQUE (tenant_id, send_id, response_type),
  CHECK (response_type NOT IN ('opt_out', 'bounce') OR lead_id IS NULL),
  FOREIGN KEY (tenant_id, send_id) REFERENCES campaign_sends (tenant_id, send_id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, lead_id)
);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 6 — ATTRIBUTION, AND THE REVENUE IT REFUSES TO INVENT
-- ────────────────────────────────────────────────────────────────────────────

CREATE TABLE attribution_runs (
  attribution_run_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  rooftop_id              UUID NOT NULL,
  model                   TEXT NOT NULL
                            CHECK (model IN ('first_touch', 'last_touch', 'linear')),
  -- The window the run covers. Deterministic input: the same window, the same
  -- model and the same touches must produce the same credit, every time.
  window_start            TIMESTAMPTZ NOT NULL,
  window_end              TIMESTAMPTZ NOT NULL,
  state                   TEXT NOT NULL DEFAULT 'computed'
                            CHECK (state IN ('computed', 'superseded')),
  leads_considered        INTEGER NOT NULL DEFAULT 0 CHECK (leads_considered >= 0),
  touches_credited        INTEGER NOT NULL DEFAULT 0 CHECK (touches_credited >= 0),
  -- THE REVENUE CONTRACT, HELD OPEN AND DECLARED EMPTY.
  --
  -- Sales does not exist in this platform yet, so there is no revenue to
  -- attribute and no ROI to compute. The columns a revenue consumer will need
  -- are here, and the CHECK makes the only currently-writable state the honest
  -- one: NOT_YET_AVAILABLE carries no amount. A zero would be a measurement,
  -- and this is an absence.
  -- STRUCTURALLY PROHIBITED, NOT MERELY UNWRITTEN (RT3-C1 §4).
  --
  -- The vocabulary keeps both values because a revenue consumer will need
  -- 'AVAILABLE' the day FBL-100 lands, but until then the second CHECK below
  -- makes it UNREPRESENTABLE. A convention that says "we never write AVAILABLE"
  -- is a convention: it holds until somebody writes it, and the first person to
  -- do so gets a green test suite and an invented number. A constraint holds
  -- because the database refuses the row.
  --
  -- FBL-100's migration relaxes `ck_attribution_pre_sale_revenue` when a real
  -- sale exists to attribute money to. Until that migration is written, this
  -- table cannot claim revenue at all.
  revenue_status          TEXT NOT NULL DEFAULT 'NOT_YET_AVAILABLE'
                            CHECK (revenue_status IN ('NOT_YET_AVAILABLE', 'AVAILABLE')),
  attributed_revenue_cents BIGINT CHECK (attributed_revenue_cents IS NULL
                                         OR attributed_revenue_cents >= 0),
  campaign_cost_cents     BIGINT CHECK (campaign_cost_cents IS NULL OR campaign_cost_cents >= 0),
  computed_by_user_link_id UUID NOT NULL,
  updated_by_user_link_id UUID NOT NULL,
  authorization_version   BIGINT NOT NULL DEFAULT 1,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, attribution_run_id),
  CHECK (window_end > window_start),
  CONSTRAINT ck_attribution_pre_sale_revenue CHECK (
    revenue_status = 'NOT_YET_AVAILABLE'
    AND attributed_revenue_cents IS NULL
    AND campaign_cost_cents IS NULL
  ),
  FOREIGN KEY (tenant_id, rooftop_id) REFERENCES rooftops (tenant_id, rooftop_id),
  FOREIGN KEY (tenant_id, computed_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id),
  FOREIGN KEY (tenant_id, updated_by_user_link_id) REFERENCES user_links (tenant_id, user_link_id)
);
CREATE UNIQUE INDEX uq_attribution_runs_current
  ON attribution_runs (tenant_id, rooftop_id, model, window_start, window_end)
  WHERE state = 'computed';

-- THE CREDIT ITSELF, append-only. Weights are BASIS POINTS so the arithmetic is
-- exact: a linear split across three touches is 3334/3333/3333, which sums to
-- 10000 and can be checked. A float would not.
CREATE TABLE lead_attributions (
  attribution_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL REFERENCES tenants (tenant_id),
  attribution_run_id      UUID NOT NULL,
  lead_id                 UUID NOT NULL,
  touch_id                UUID NOT NULL,
  lead_source_id          UUID NOT NULL,
  campaign_version_id     UUID,
  weight_bp               INTEGER NOT NULL CHECK (weight_bp BETWEEN 0 AND 10000),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, attribution_id),
  UNIQUE (tenant_id, attribution_run_id, lead_id, touch_id),
  FOREIGN KEY (tenant_id, attribution_run_id)
    REFERENCES attribution_runs (tenant_id, attribution_run_id),
  FOREIGN KEY (tenant_id, lead_id) REFERENCES leads (tenant_id, lead_id),
  FOREIGN KEY (tenant_id, touch_id) REFERENCES lead_source_touches (tenant_id, touch_id),
  FOREIGN KEY (tenant_id, lead_source_id) REFERENCES lead_sources (tenant_id, lead_source_id),
  FOREIGN KEY (tenant_id, campaign_version_id)
    REFERENCES campaign_versions (tenant_id, campaign_version_id)
);
CREATE INDEX idx_lead_attributions_run ON lead_attributions (tenant_id, attribution_run_id, lead_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Section 7 — GRANTS
--
-- The same rule migration 062 applied: the runtime may add to and correct the
-- tables that hold current state, and may only ADD to the ones that hold
-- history. DELETE is granted to exactly one table — `campaign_audience_members`
-- is replaced as a whole set while a version is still a draft, and a set that
-- can only be added to cannot be corrected.
-- ────────────────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON
  lead_sources, leads, lead_queues, lead_sla_policies,
  lead_activities, appointments,
  party_purpose_consents, contact_suppressions,
  campaigns, campaign_versions, campaign_sends,
  attribution_runs
  TO dealership_runtime;

-- APPEND-ONLY EVIDENCE GETS NO UPDATE. Intake decisions, source touches,
-- assignment and status history, escalations, the handoff, appointment history,
-- the frozen template, delivery history, replies and computed credit are all
-- records of what happened. Correcting one means writing a further row.
GRANT SELECT, INSERT ON
  lead_intakes, lead_source_touches, lead_assignments, lead_status_events,
  lead_escalations, lead_handoffs, appointment_events,
  campaign_templates, campaign_send_events, campaign_responses,
  lead_attributions
  TO dealership_runtime;

GRANT SELECT, INSERT, DELETE ON campaign_audience_members TO dealership_runtime;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 8 — THE RESOURCE REGISTRY
--
-- Three new rooftop-owned resources: a lead, an appointment and a campaign.
-- Everything hanging off them — activities, assignments, sends, responses — is
-- authorized THROUGH ITS PARENT, exactly as Release Train 2's stock children
-- are, so the rooftop that owns the lead governs its follow-up.
--
-- BOTH resolvers are re-declared, and they must stay in step: migration 062
-- split them by privilege — `resource_org_leaf` keeps the row-security bypass
-- and is executable only by `dealership_evidence_owner`, while
-- `resource_org_leaf_visible` is the ordinary lookup the engine calls. A
-- resource type registered in one and missing from the other would authorize
-- differently from how it is validated, and `tests/architecture.test.ts` holds
-- the two branch lists identical.
--
-- The REVOKE and GRANT are restated below. `CREATE OR REPLACE FUNCTION`
-- preserves an existing ACL, so they are not strictly required here — they are
-- written down anyway, because a reader of this migration should not have to
-- know that rule to know who may call the function, and a future
-- `DROP`/`CREATE` would silently restore the PUBLIC default without them.
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
  END IF;
  RETURN leaf;
END;
$$ LANGUAGE plpgsql STABLE;

REVOKE ALL ON FUNCTION resource_org_leaf_visible(text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resource_org_leaf_visible(text, uuid) TO dealership_runtime;

-- ────────────────────────────────────────────────────────────────────────────
-- Section 9 — DENY-BY-DEFAULT ROW SECURITY
--
-- The same one sentence migrations 061 and 062 established: a row is visible
-- and writable exactly when its tenant IS the transaction's server-set tenant
-- context. No context, no rows.
-- ────────────────────────────────────────────────────────────────────────────

ALTER TABLE lead_sources               ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads                      ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intakes               ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_source_touches        ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_queues                ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_assignments           ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_status_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_sla_policies          ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_escalations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_handoffs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_activities            ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments               ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointment_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE party_purpose_consents     ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_suppressions       ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_versions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_templates         ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_audience_members  ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_sends             ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_send_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_responses         ENABLE ROW LEVEL SECURITY;
ALTER TABLE attribution_runs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_attributions          ENABLE ROW LEVEL SECURITY;

CREATE POLICY rls_lead_sources_tenant ON lead_sources
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_leads_tenant ON leads
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_lead_intakes_tenant ON lead_intakes
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_lead_source_touches_tenant ON lead_source_touches
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_lead_queues_tenant ON lead_queues
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_lead_assignments_tenant ON lead_assignments
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_lead_status_events_tenant ON lead_status_events
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_lead_sla_policies_tenant ON lead_sla_policies
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_lead_escalations_tenant ON lead_escalations
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_lead_handoffs_tenant ON lead_handoffs
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_lead_activities_tenant ON lead_activities
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_appointments_tenant ON appointments
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_appointment_events_tenant ON appointment_events
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_party_purpose_consents_tenant ON party_purpose_consents
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_contact_suppressions_tenant ON contact_suppressions
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_campaigns_tenant ON campaigns
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_campaign_versions_tenant ON campaign_versions
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_campaign_templates_tenant ON campaign_templates
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_campaign_audience_members_tenant ON campaign_audience_members
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_campaign_sends_tenant ON campaign_sends
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_campaign_send_events_tenant ON campaign_send_events
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_campaign_responses_tenant ON campaign_responses
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_attribution_runs_tenant ON attribution_runs
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
CREATE POLICY rls_lead_attributions_tenant ON lead_attributions
  FOR ALL TO dealership_runtime
  USING (tenant_id = app_tenant_ctx()) WITH CHECK (tenant_id = app_tenant_ctx());
