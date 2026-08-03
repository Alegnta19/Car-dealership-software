import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RO_STATUSES,
  RO_TRANSITIONS,
  allowedTransitionsFrom,
  isTransitionAllowed,
  transitionRequiresAuthorization,
  transitionRequiresStepUp,
} from '@dealer/fixed-ops';

test('every status has a transition entry and every target is a real status', () => {
  for (const status of RO_STATUSES) {
    assert.ok(Array.isArray(RO_TRANSITIONS[status]), `${status} has no transition list`);
    for (const target of RO_TRANSITIONS[status]) {
      assert.ok(RO_STATUSES.includes(target), `${status} -> ${target} is not a known status`);
    }
  }
});

test('canceled is terminal and every other non-final state can still move', () => {
  assert.deepEqual(RO_TRANSITIONS.canceled, []);
  for (const status of RO_STATUSES) {
    if (status === 'canceled') continue;
    assert.ok(RO_TRANSITIONS[status].length > 0, `${status} is a dead end`);
  }
});

test('the happy path is walkable end to end', () => {
  const path = [
    'draft',
    'checked_in',
    'inspection_in_progress',
    'estimate_pending',
    'awaiting_authorization',
    'authorized',
    'in_repair',
    'qc',
    'ready_for_pickup',
    'closed',
  ];
  for (let i = 0; i < path.length - 1; i += 1) {
    assert.ok(
      isTransitionAllowed(path[i], path[i + 1]),
      `${path[i]} -> ${path[i + 1]} should be allowed`,
    );
  }
});

test('illegal shortcuts are rejected', () => {
  assert.equal(isTransitionAllowed('draft', 'closed'), false);
  assert.equal(isTransitionAllowed('checked_in', 'authorized'), false);
  assert.equal(isTransitionAllowed('canceled', 'checked_in'), false);
  assert.equal(isTransitionAllowed('closed', 'in_repair'), false);
});

test('unknown source statuses expose no transitions rather than throwing', () => {
  assert.deepEqual(allowedTransitionsFrom('not_a_status'), []);
  assert.equal(isTransitionAllowed('not_a_status', 'closed'), false);
});

test('authorized and canceled are the step-up gated transitions', () => {
  assert.ok(transitionRequiresStepUp('authorized'));
  assert.ok(transitionRequiresStepUp('canceled'));
  assert.equal(transitionRequiresStepUp('in_repair'), false);
  assert.equal(transitionRequiresStepUp('closed'), false);
});

test('only the authorized transition is gated on customer authorization evidence', () => {
  assert.ok(transitionRequiresAuthorization('authorized'));
  assert.equal(transitionRequiresAuthorization('in_repair'), false);
});
