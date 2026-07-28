import assert from 'node:assert/strict';
import { test } from 'node:test';
import { signStepUpToken, verifyStepUpToken } from '../src/shared/security/step-up';

// The module reads its secret per call, so setting it here is enough.
process.env.STEP_UP_SECRET = 'test-step-up-secret-that-is-long-enough-32';

const binding = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  action: 'ro.transition:authorized',
  resourceId: '33333333-3333-4333-8333-333333333333',
};

function expectRejected(fn: () => void, because: string): void {
  assert.throws(fn, (err: any) => err?.code === 'step_up_required' && err?.statusCode === 403, because);
}

test('a correctly bound token verifies', () => {
  verifyStepUpToken(signStepUpToken(binding), binding);
});

test('a token for another repair order is rejected', () => {
  expectRejected(
    () => verifyStepUpToken(signStepUpToken(binding), { ...binding, resourceId: '44444444-4444-4444-8444-444444444444' }),
    'resource binding must be enforced',
  );
});

test('a token for another user is rejected', () => {
  expectRejected(
    () => verifyStepUpToken(signStepUpToken(binding), { ...binding, userId: '55555555-5555-4555-8555-555555555555' }),
    'user binding must be enforced',
  );
});

test('a token for another tenant is rejected', () => {
  expectRejected(
    () => verifyStepUpToken(signStepUpToken(binding), { ...binding, tenantId: '66666666-6666-4666-8666-666666666666' }),
    'tenant binding must be enforced',
  );
});

test('a token minted for a different action is rejected', () => {
  expectRejected(
    () => verifyStepUpToken(signStepUpToken(binding), { ...binding, action: 'ro.transition:canceled' }),
    'action binding must be enforced',
  );
});

test('an expired token is rejected', () => {
  expectRejected(() => verifyStepUpToken(signStepUpToken(binding, -1), binding), 'expiry must be enforced');
});

test('a tampered payload is rejected', () => {
  const token = signStepUpToken(binding);
  const [body, signature] = token.split('.');
  const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  forged.resourceId = '77777777-7777-4777-8777-777777777777';
  const tamperedBody = Buffer.from(JSON.stringify(forged)).toString('base64url');
  expectRejected(() => verifyStepUpToken(`${tamperedBody}.${signature}`, binding), 'signature must cover the payload');
});

test('missing, empty and non-string tokens are rejected', () => {
  for (const value of [undefined, null, '', 'not-a-token', 42, {}]) {
    expectRejected(() => verifyStepUpToken(value, binding), `rejects ${JSON.stringify(value)}`);
  }
});
