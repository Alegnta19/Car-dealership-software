/**
 * RELEASE TRAIN 1 — THE DEALERSHIP ADMINISTRATION SURFACE (/api/admin).
 *
 * The staff UI's API: dealership settings, business hours, bounded policies,
 * the organization tree (dealer groups → legal entities → rooftops →
 * departments), users, role/rooftop access, and staff invitations. Every route
 * is `authenticate` + `requireAction(<catalog action>)` — the same one policy
 * path as every other surface, every decision leaving its evidence row.
 *
 * This surface adopts RFC 9457 for its wire contract (the internal Problem
 * Details model FBL-010 built and FBL-040 owns): errors are
 * `application/problem+json` with type/title/status/detail/instance plus the
 * stable `code` and both correlation identifiers, rendered by this router's
 * OWN error middleware. The legacy `{success:false,error}` envelope on the
 * pre-train surfaces is characterized by tests and does not change.
 *
 * Command semantics (acceptance row 4):
 *   * successes are plain JSON documents (no envelope);
 *   * creating commands honor `Idempotency-Key`: the outcome is recorded in
 *     the SAME transaction as the effect, a retry replays it
 *     (`Idempotency-Replayed: true`), and the same key on a different request
 *     is a 422 problem;
 *   * PUT/PATCH commands converge naturally (full replacement or a
 *     version-guarded update) and need no key;
 *   * sensitive actions (role grant/revoke, user deactivation — the catalog's
 *     `sensitive: true` set) spend a single-use step-up grant
 *     (`step_up_token`) INSIDE the command's transaction, exactly like the
 *     support-approval path.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  DEALERSHIP_POLICY_CATALOG,
  INVITABLE_ROLES,
  changeOrganizationUnitStatus,
  consumeReauthenticationGrant,
  createOrganizationUnitWithin,
  createStaffInvitation,
  deactivateUserLinkWithin,
  getAdminOverviewCounts,
  getDealershipSettings,
  getOrganizationUnitStatus,
  grantRoleWithin,
  listBusinessHours,
  listDealershipPolicies,
  listOrganizationTree,
  listStaffInvitations,
  listTenantUsers,
  replaceBusinessHours,
  requestFingerprint,
  revokeRoleWithin,
  revokeStaffInvitation,
  runIdempotentAdminCommand,
  setDealershipPolicy,
  tenantHoldsRoleBinding,
  tenantHoldsUserLink,
  upsertDealershipSettings,
  type BusinessHoursDay,
  type OrganizationUnitLevel,
} from '@dealer/identity-access';
import type { Executor } from '@dealer/database';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
  getRequestContext,
  toProblemDetails,
} from '@dealer/platform';
import {
  authenticate,
  rejectTenantOverride,
  requireAction,
  requireContext,
} from '../middleware/auth';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Row {
  [key: string]: unknown;
}

/** Route bodies throw; this funnels rejections into the problem renderer. */
function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    try {
      rejectTenantOverride(req);
    } catch (err) {
      next(err);
      return;
    }
    fn(req, res).catch(next);
  };
}

function tenantOf(req: Request): string {
  const ctx = requireContext(req);
  if (ctx.tenantId === null || ctx.tenantId === undefined) {
    throw new ForbiddenError('The administration surface is tenant-scoped', {
      code: 'tenant_required',
    });
  }
  return ctx.tenantId;
}

function actorOf(req: Request): string {
  return requireContext(req).userId;
}

function requireUuidParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new NotFoundError('Resource not found');
  }
  return value;
}

function idempotencyKeyOf(req: Request): string | null {
  const raw = req.header('idempotency-key');
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 128) {
    throw new ValidationError('Idempotency-Key must be 1-128 characters', {
      code: 'idempotency_key_invalid',
    });
  }
  return trimmed;
}

/**
 * Runs a creating command exactly once per Idempotency-Key and renders its
 * recorded outcome. `work` computes {status, body} inside the SAME transaction
 * that records it; a thrown error aborts everything (no key row, no effect),
 * so a retry after a validation refusal re-validates rather than replaying.
 */
async function idempotent(
  req: Request,
  res: Response,
  work: (tx: Executor) => Promise<{ status: number; body: unknown }>,
): Promise<void> {
  const outcome = await runIdempotentAdminCommand({
    tenantId: tenantOf(req),
    actorUserLinkId: actorOf(req),
    idempotencyKey: idempotencyKeyOf(req),
    fingerprint: requestFingerprint(
      req.method,
      req.originalUrl.split('?')[0] ?? req.path,
      req.body,
    ),
    work,
  });
  if (outcome.conflict === true) {
    throw new UnprocessableError('This Idempotency-Key was already used for a different request', {
      code: 'idempotency_key_conflict',
    });
  }
  if (outcome.replayed) res.setHeader('Idempotency-Replayed', 'true');
  res.status(outcome.status).json(outcome.body);
}

/** Spends the step-up grant a sensitive administration action requires. */
async function spendStepUp(tx: Executor, req: Request, action: string): Promise<void> {
  const token = ((req.body ?? {}) as Row).step_up_token;
  if (typeof token !== 'string' || token.length === 0) {
    throw new ForbiddenError('This sensitive action requires a step-up token', {
      code: 'step_up_required',
      details: { required_action: action },
    });
  }
  const spent = await consumeReauthenticationGrant(tx, {
    grant: token,
    tenantId: tenantOf(req),
    userLinkId: actorOf(req),
    action,
    resourceType: null,
    resourceId: null,
  });
  if (!spent) {
    throw new ForbiddenError('The step-up token is invalid, expired, or already used', {
      code: 'step_up_rejected',
      details: { required_action: action },
    });
  }
}

// ── overview ────────────────────────────────────────────────────────────────

router.get(
  '/overview',
  authenticate,
  requireAction('admin.dealership.view'),
  handler(async (req, res) => {
    const tenantId = tenantOf(req);
    const [settings, hours, policies, invitations, counts] = await Promise.all([
      getDealershipSettings(tenantId),
      listBusinessHours(tenantId),
      listDealershipPolicies(tenantId),
      listStaffInvitations(tenantId),
      getAdminOverviewCounts(tenantId),
    ]);
    res.json({
      tenant: { tenantId, name: counts.tenantName },
      settings,
      businessHours: hours,
      policies,
      invitations: invitations.filter((i) => i.status === 'pending'),
      counts: {
        rooftops: counts.rooftops,
        departments: counts.departments,
        activeUsers: counts.activeUsers,
        pendingUsers: counts.pendingUsers,
      },
      policyCatalog: DEALERSHIP_POLICY_CATALOG.map((p) => ({
        key: p.key,
        description: p.description,
      })),
      invitableRoles: INVITABLE_ROLES,
    });
  }),
);

// ── settings ────────────────────────────────────────────────────────────────

router.get(
  '/settings',
  authenticate,
  requireAction('admin.dealership.view'),
  handler(async (req, res) => {
    res.json({ settings: await getDealershipSettings(tenantOf(req)) });
  }),
);

router.put(
  '/settings',
  authenticate,
  requireAction('admin.settings.update'),
  handler(async (req, res) => {
    const body = (req.body ?? {}) as Row;
    if (typeof body.display_name !== 'string' || body.display_name.length === 0) {
      throw new ValidationError('display_name is required', { code: 'display_name_required' });
    }
    const expected =
      body.expected_version === null || body.expected_version === undefined
        ? null
        : Number(body.expected_version);
    if (expected !== null && !Number.isInteger(expected)) {
      throw new ValidationError('expected_version must be an integer or null', {
        code: 'expected_version_invalid',
      });
    }
    const optionalString = (v: unknown): string | null =>
      v === null || v === undefined ? null : String(v);
    const result = await upsertDealershipSettings({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      expectedVersion: expected,
      settings: {
        displayName: body.display_name,
        legalName: optionalString(body.legal_name),
        brandPrimaryColor: optionalString(body.brand_primary_color),
        logoUrl: optionalString(body.logo_url),
        timezone: typeof body.timezone === 'string' ? body.timezone : 'UTC',
        locale: optionalString(body.locale),
      },
    });
    if (result.outcome === 'version_conflict') {
      throw new ConflictError('Settings changed since you loaded them — reload and retry', {
        code: 'version_conflict',
        details: { current_version: result.currentVersion },
      });
    }
    res.json({ settings: result.settings });
  }),
);

// ── business hours ──────────────────────────────────────────────────────────

router.get(
  '/business-hours',
  authenticate,
  requireAction('admin.dealership.view'),
  handler(async (req, res) => {
    res.json({ businessHours: await listBusinessHours(tenantOf(req)) });
  }),
);

router.put(
  '/business-hours',
  authenticate,
  requireAction('admin.hours.update'),
  handler(async (req, res) => {
    const body = (req.body ?? {}) as Row;
    if (!Array.isArray(body.days)) {
      throw new ValidationError('days must be an array', { code: 'days_required' });
    }
    const days: BusinessHoursDay[] = (body.days as Row[]).map((d) => ({
      dayOfWeek: Number(d.day_of_week),
      closed: d.closed === true,
      openTime: d.open_time === null || d.open_time === undefined ? null : String(d.open_time),
      closeTime: d.close_time === null || d.close_time === undefined ? null : String(d.close_time),
    }));
    const result = await replaceBusinessHours({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      days,
    });
    if ('error' in result) {
      throw new UnprocessableError(result.error, { code: 'business_hours_invalid' });
    }
    res.json({ businessHours: result.days });
  }),
);

// ── policies ────────────────────────────────────────────────────────────────

router.get(
  '/policies',
  authenticate,
  requireAction('admin.dealership.view'),
  handler(async (req, res) => {
    res.json({
      policies: await listDealershipPolicies(tenantOf(req)),
      catalog: DEALERSHIP_POLICY_CATALOG.map((p) => ({ key: p.key, description: p.description })),
    });
  }),
);

router.put(
  '/policies/:policyKey',
  authenticate,
  requireAction('admin.policy.update'),
  handler(async (req, res) => {
    const body = (req.body ?? {}) as Row;
    const result = await setDealershipPolicy({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      policyKey: String(req.params.policyKey ?? ''),
      policyValue: body.value,
    });
    if ('error' in result) {
      throw new UnprocessableError(result.error, { code: 'policy_invalid' });
    }
    res.json({ policy: result.policy });
  }),
);

// ── organization (dealer groups → legal entities → rooftops → departments) ──

const UNIT_LEVELS: readonly OrganizationUnitLevel[] = [
  'dealer_group',
  'legal_entity',
  'rooftop',
  'department',
];
const UNIT_STATUSES = ['pending_configuration', 'active', 'inactive', 'archived'] as const;

router.get(
  '/organization',
  authenticate,
  requireAction('admin.dealership.view'),
  handler(async (req, res) => {
    res.json(await listOrganizationTree(tenantOf(req)));
  }),
);

router.post(
  '/organization/:level',
  authenticate,
  requireAction('org.unit.create'),
  handler(async (req, res) => {
    const level = String(req.params.level ?? '') as OrganizationUnitLevel;
    if (!UNIT_LEVELS.includes(level)) {
      throw new NotFoundError('Resource not found');
    }
    const body = (req.body ?? {}) as Row;
    if (typeof body.name !== 'string' || body.name.length === 0) {
      throw new ValidationError('name is required', { code: 'name_required' });
    }
    const tenantId = tenantOf(req);
    const parentId =
      level === 'dealer_group' ? tenantId : String((body.parent_id as string | undefined) ?? '');
    if (level !== 'dealer_group' && !UUID_RE.test(parentId)) {
      throw new ValidationError('parent_id is required', { code: 'parent_required' });
    }
    if (level === 'department' && (typeof body.code !== 'string' || body.code.length === 0)) {
      throw new ValidationError('a department requires a code', { code: 'code_required' });
    }
    await idempotent(req, res, async (tx) => {
      const created = await createOrganizationUnitWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId,
        level,
        parentId,
        name: body.name as string,
        ...(level === 'department' ? { code: body.code as string } : {}),
        status: 'active',
      });
      return {
        status: 201,
        body: { unit: { level, unitId: created.unitId, status: created.status } },
      };
    });
  }),
);

router.patch(
  '/organization/:level/:unitId/status',
  authenticate,
  requireAction('org.unit.update_status'),
  handler(async (req, res) => {
    const level = String(req.params.level ?? '') as OrganizationUnitLevel;
    if (!UNIT_LEVELS.includes(level)) throw new NotFoundError('Resource not found');
    const unitId = requireUuidParam(req, 'unitId');
    const status = String(((req.body ?? {}) as Row).status ?? '');
    if (!(UNIT_STATUSES as readonly string[]).includes(status)) {
      throw new ValidationError('status must be a known organization status', {
        code: 'status_invalid',
      });
    }
    const tenantId = tenantOf(req);
    const changed = await changeOrganizationUnitStatus({
      actingUserLinkId: actorOf(req),
      tenantId,
      level,
      unitId,
      status: status as (typeof UNIT_STATUSES)[number],
    });
    if (changed !== null) {
      res.json({ unit: { level, unitId: changed.unitId, status: changed.status } });
      return;
    }
    // No row changed: either the unit is unknown here, or it already carries
    // this status. A retried PATCH must converge, not 404 its own success.
    const current = await getOrganizationUnitStatus(tenantId, level, unitId);
    if (current !== status) {
      throw new NotFoundError('Resource not found');
    }
    res.json({ unit: { level, unitId, status } });
  }),
);

// ── users, roles and invitations ────────────────────────────────────────────

router.get(
  '/users',
  authenticate,
  requireAction('admin.dealership.view'),
  handler(async (req, res) => {
    const tenantId = tenantOf(req);
    res.json({
      users: await listTenantUsers(tenantId),
      invitations: await listStaffInvitations(tenantId),
    });
  }),
);

router.post(
  '/users/invite',
  authenticate,
  requireAction('admin.invitation.create'),
  handler(async (req, res) => {
    const body = (req.body ?? {}) as Row;
    if (typeof body.email !== 'string' || !body.email.includes('@')) {
      throw new ValidationError('email is required', { code: 'email_required' });
    }
    if (typeof body.role !== 'string' || !INVITABLE_ROLES.includes(body.role)) {
      throw new ValidationError('role must be one of the invitable roles', {
        code: 'role_not_invitable',
        details: { invitable_roles: [...INVITABLE_ROLES] },
      });
    }
    // The invitation service (row + outbox event + audit, one transaction)
    // owns its transaction; the idempotency wrapper would nest a second one
    // around it. Invitations are naturally convergent instead: a duplicate
    // pending invitation for the address is refused as unprocessable.
    const result = await createStaffInvitation({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      email: body.email,
      displayName:
        body.display_name === null || body.display_name === undefined
          ? null
          : String(body.display_name),
      invitedRole: body.role,
      scopeLevel: typeof body.scope_level === 'string' ? body.scope_level : 'tenant',
      scopeId: body.scope_id === null || body.scope_id === undefined ? null : String(body.scope_id),
    });
    if ('error' in result) {
      throw new UnprocessableError(result.error, { code: 'invitation_invalid' });
    }
    res.status(201).json({ invitation: result.invitation });
  }),
);

router.post(
  '/invitations/:invitationId/revoke',
  authenticate,
  requireAction('admin.invitation.revoke'),
  handler(async (req, res) => {
    const invitationId = requireUuidParam(req, 'invitationId');
    const result = await revokeStaffInvitation({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      invitationId,
    });
    if (result === null) throw new NotFoundError('Resource not found');
    res.json({ invitation: result.invitation });
  }),
);

router.post(
  '/users/:userLinkId/roles',
  authenticate,
  requireAction('identity.role.grant'),
  handler(async (req, res) => {
    const userLinkId = requireUuidParam(req, 'userLinkId');
    const body = (req.body ?? {}) as Row;
    if (typeof body.role !== 'string' || !INVITABLE_ROLES.includes(body.role)) {
      throw new ValidationError('role must be one of the invitable roles', {
        code: 'role_not_invitable',
      });
    }
    const scopeLevel = typeof body.scope_level === 'string' ? body.scope_level : 'tenant';
    if (!['tenant', 'dealer_group', 'legal_entity', 'rooftop', 'department'].includes(scopeLevel)) {
      throw new ValidationError('scope_level is not a dealership scope', {
        code: 'scope_level_invalid',
      });
    }
    const tenantId = tenantOf(req);
    const scopeId =
      scopeLevel === 'tenant' ? tenantId : String((body.scope_id as string | undefined) ?? '');
    if (scopeLevel !== 'tenant' && !UUID_RE.test(scopeId)) {
      throw new ValidationError('scope_id is required for a sub-tenant scope', {
        code: 'scope_id_required',
      });
    }
    await idempotent(req, res, async (tx) => {
      // The subject must be this tenant's own link — a cross-tenant target is
      // indistinguishable from a nonexistent one.
      if (!(await tenantHoldsUserLink(tx, tenantId, userLinkId))) {
        throw new NotFoundError('Resource not found');
      }
      await spendStepUp(tx, req, 'identity.role.grant');
      const granted = await grantRoleWithin(tx, actorOf(req), {
        tenantId,
        userLinkId,
        role: body.role as string,
        scopeLevel,
        scopeId,
      });
      return {
        status: 201,
        body: { binding: { roleBindingId: granted.roleBindingId, role: granted.role } },
      };
    });
  }),
);

router.delete(
  '/users/:userLinkId/roles/:roleBindingId',
  authenticate,
  requireAction('identity.role.revoke'),
  handler(async (req, res) => {
    const userLinkId = requireUuidParam(req, 'userLinkId');
    const roleBindingId = requireUuidParam(req, 'roleBindingId');
    const tenantId = tenantOf(req);
    await idempotent(req, res, async (tx) => {
      if (!(await tenantHoldsRoleBinding(tx, tenantId, userLinkId, roleBindingId))) {
        throw new NotFoundError('Resource not found');
      }
      await spendStepUp(tx, req, 'identity.role.revoke');
      // A null result means the binding exists here but is already settled
      // (revoked); a retried revoke converges instead of refusing its own
      // earlier success.
      await revokeRoleWithin(tx, actorOf(req), roleBindingId);
      return { status: 200, body: { binding: { roleBindingId, status: 'revoked' } } };
    });
  }),
);

router.post(
  '/users/:userLinkId/deactivate',
  authenticate,
  requireAction('identity.user.deactivate'),
  handler(async (req, res) => {
    const userLinkId = requireUuidParam(req, 'userLinkId');
    const tenantId = tenantOf(req);
    if (userLinkId === actorOf(req)) {
      throw new UnprocessableError('You cannot deactivate your own account', {
        code: 'self_deactivation_refused',
      });
    }
    await idempotent(req, res, async (tx) => {
      if (!(await tenantHoldsUserLink(tx, tenantId, userLinkId))) {
        throw new NotFoundError('Resource not found');
      }
      await spendStepUp(tx, req, 'identity.user.deactivate');
      // false = already deactivated; the command converges either way.
      await deactivateUserLinkWithin(tx, actorOf(req), userLinkId);
      return { status: 200, body: { user: { userLinkId, status: 'deactivated' } } };
    });
  }),
);

// ── problem+json rendering (RFC 9457) ───────────────────────────────────────

/** Everything unmatched under /api/admin is a problem, not the legacy envelope. */
router.use((req: Request, res: Response) => {
  const context = getRequestContext();
  const instance = req.originalUrl.split('?')[0] ?? '';
  res
    .status(404)
    .type('application/problem+json')
    .json({
      type: 'urn:dealer:error:route_not_found',
      title: 'Not Found',
      status: 404,
      detail: `No route for ${req.method} ${instance}`,
      instance,
      code: 'route_not_found',
      ...(context !== undefined
        ? { requestId: context.requestId, correlationId: context.correlationId }
        : {}),
    });
});

// Express recognizes an error handler by its arity — the fourth parameter must
// exist even though this terminal renderer never calls it (same as
// middleware/error-handler.ts).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
router.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
  const problem = toProblemDetails(err, {
    instance: req.originalUrl.split('?')[0] ?? req.path,
  });
  const context = getRequestContext();
  res
    .status(problem.status)
    .type('application/problem+json')
    .json({
      ...problem,
      ...(context !== undefined ? { correlationId: context.correlationId } : {}),
      // Details never carry another tenant's data: every AppError thrown on
      // this surface builds them from the caller's own request.
      ...(err instanceof AppError && err.details !== undefined ? { errors: err.details } : {}),
    });
});

export default router;
