import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  deriveAuthorizationStatus,
  deriveEstimateStatus,
  isAuthorizationMethod,
  methodRequiresStepUp,
} from '../src/modules/service-cockpit/domain/authorization';

test('an authorization is approved only when at least one line was approved', () => {
  assert.equal(deriveAuthorizationStatus(['a'], []), 'approved');
  assert.equal(deriveAuthorizationStatus(['a'], ['b']), 'approved');
});

test('an all-declined decision is recorded as declined, not approved', () => {
  // This is the regression that made the repair-order authorization gate vacuous:
  // the original code stored status='approved' unconditionally.
  assert.equal(deriveAuthorizationStatus([], ['b', 'c']), 'declined');
});

test('an empty decision is never approved', () => {
  assert.equal(deriveAuthorizationStatus([], []), 'pending');
});

test('estimate status reflects how much of the estimate the customer accepted', () => {
  // Third argument is how many lines remain UNDECIDED after this decision.
  assert.equal(deriveEstimateStatus(3, 0, 0), 'approved', 'all lines approved, none left');
  assert.equal(deriveEstimateStatus(2, 1, 0), 'partially_approved', 'some declined');
  assert.equal(deriveEstimateStatus(0, 3, 0), 'declined', 'all declined');
});

test('an estimate with lines still undecided is never marked approved', () => {
  // The regression this guards: deriving from a whole-repair-order count let an
  // estimate read "approved" while lines it covers were still awaiting a decision.
  assert.equal(deriveEstimateStatus(1, 0, 2), 'partially_approved');
  assert.equal(deriveEstimateStatus(3, 0, 1), 'partially_approved');
  assert.equal(deriveEstimateStatus(0, 1, 2), 'partially_approved', 'declines alone do not close it');
});

test('authorization methods are a closed set', () => {
  assert.ok(isAuthorizationMethod('portal'));
  assert.ok(isAuthorizationMethod('staff_attestation'));
  assert.equal(isAuthorizationMethod('verbal'), false);
  assert.equal(isAuthorizationMethod(''), false);
  assert.equal(isAuthorizationMethod(undefined), false);
});

test('only staff-asserted methods require step-up', () => {
  assert.ok(methodRequiresStepUp('staff_attestation'));
  assert.equal(methodRequiresStepUp('portal'), false);
  assert.equal(methodRequiresStepUp('signature'), false);
  assert.equal(methodRequiresStepUp('recorded_call_ref'), false);
});
