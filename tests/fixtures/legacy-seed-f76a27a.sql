-- Legacy data as the earliest retained schema (f76a27a: migrations 000 + 049) allowed
-- it — applied by the CI upgrade job BEFORE the current migration chain runs on top.
--
-- The free-text queue_type and root_cause_category rows are the point: that schema had
-- no CHECK on either column, which is exactly why migration 050 adds its constraints
-- NOT VALID. If anyone ever "tidies" those constraints into immediately-validating
-- ones, this seed makes the upgrade job fail — the same defect that once made 050 abort
-- on real data and left 051 unreachable, now guarded at CI level.

INSERT INTO service_appointments (appointment_id, tenant_id, location_id, mdm_customer_id, mdm_vehicle_id, scheduled_start, status)
VALUES ('11111111-1111-4111-8111-111111111111', '99999999-9999-4999-8999-999999999999',
        '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
        '44444444-4444-4444-8444-444444444444', NOW() - INTERVAL '400 days', 'converted_to_ro');

INSERT INTO repair_orders (ro_id, tenant_id, location_id, appointment_id, mdm_customer_id, mdm_vehicle_id, status)
VALUES ('55555555-5555-4555-8555-555555555555', '99999999-9999-4999-8999-999999999999',
        '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111',
        '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', 'closed'),
       ('66666666-6666-4666-8666-666666666666', '99999999-9999-4999-8999-999999999999',
        '22222222-2222-4222-8222-222222222222', NULL,
        '33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444', 'closed');

-- Free text that predates the 050 CHECK constraints.
INSERT INTO service_queue_items (tenant_id, location_id, queue_type, status)
VALUES ('99999999-9999-4999-8999-999999999999', '22222222-2222-4222-8222-222222222222',
        'legacy express lane', 'done');

INSERT INTO comeback_cases (tenant_id, original_ro_id, new_ro_id, root_cause_category, status)
VALUES ('99999999-9999-4999-8999-999999999999', '55555555-5555-4555-8555-555555555555',
        '66666666-6666-4666-8666-666666666666', 'came back - misc', 'resolved');

-- A line item whose price_ref the 049-era schema accepted as any JSON — the delivery
-- gate's cast-safety (round five) is what tolerates this row existing.
INSERT INTO ro_line_items (tenant_id, ro_id, line_type, description, status, authorization_status, price_ref)
VALUES ('99999999-9999-4999-8999-999999999999', '55555555-5555-4555-8555-555555555555',
        'parts', 'Legacy priced part', 'completed', 'not_required', '{"amount_cents": "call for price"}');
