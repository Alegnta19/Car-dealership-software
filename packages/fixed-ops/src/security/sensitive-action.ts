/**
 * Sensitive-action gate (FBL-020): consumes a provider-backed
 * REAUTHENTICATION GRANT (ADR-006) where the retired local step-up token
 * used to be burned. Same shape on purpose:
 *
 *   - called on the executor of the business transaction, so the spend
 *     commits (or rolls back) with the privileged write it authorizes;
 *   - bound to tenant + user + exact action string + repair order — a grant
 *     minted for one thing can never pay for another;
 *   - single-use: the conditional UPDATE lets exactly one consumption win;
 *   - every failure is the same hard refusal, and the HTTP error code stays
 *     `step_up_required` — the external contract survives the mechanism
 *     change.
 */
import { Executor } from '@dealer/database';
import { ForbiddenError } from '@dealer/platform';
import { consumeReauthenticationGrant } from '@dealer/identity-access';

export interface SensitiveActionBinding {
  /** Defaults to fresh_and_mfa_policy: these are money-affecting actions. */
  requiredAssurance?: 'fresh_only' | 'fresh_and_mfa_policy';
  tenantId: string;
  /** the actor's user_link_id */
  userId: string;
  /** e.g. `service.ro.transition:authorized` */
  action: string;
  /** The repair order being acted on. */
  resourceId: string;
}

export async function consumeSensitiveActionGrant(
  ex: Executor,
  grant: unknown,
  expected: SensitiveActionBinding,
): Promise<void> {
  const refuse = (reason: string): never => {
    throw new ForbiddenError('Reauthentication is required for this action', {
      code: 'step_up_required',
      details: { reason, action: expected.action },
    });
  };
  if (typeof grant !== 'string' || grant.length === 0) refuse('missing_grant');

  const consumed = await consumeReauthenticationGrant(ex, {
    grant: grant as string,
    tenantId: expected.tenantId,
    userLinkId: expected.userId,
    action: expected.action,
    resourceType: 'repair_order',
    resourceId: expected.resourceId,
    // FBL-020-R2: money-affecting Fixed Ops operations are high assurance.
    // A fresh_only grant is refused in the same statement that would spend it.
    requiredAssurance: expected.requiredAssurance ?? 'fresh_and_mfa_policy',
  });
  if (!consumed) refuse('grant_invalid_expired_or_spent');
}
