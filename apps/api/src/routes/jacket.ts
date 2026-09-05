/**
 * FBL-140 — THE DEAL JACKET SURFACE (/api/jacket), for STAFF.
 *
 * The conventions the earlier trains established, because they are the ones
 * this repository's gates and reviewers expect: `authenticate` + `requireAction`,
 * problem+json errors, `Idempotency-Key` on creating commands with the outcome
 * recorded in the same transaction as the effect, and `expected_version`
 * optimistic concurrency.
 *
 * EVERY CHILD IS ADDRESSED THROUGH ITS AUTHORIZED PARENT. A route whose action
 * declares `resourceType: 'deal_jacket'` carries `:jacketId`, one that declares
 * `jacket_package` carries `:packageId`, and one that declares
 * `signing_ceremony` carries `:ceremonyId` — so a row belonging to a different
 * parent is NOT FOUND rather than acted on.
 *
 * TWO LANES ARE NOT ON THIS ROUTER. The customer signs through `/sign/api`
 * with a lane token; the provider calls back through
 * `/api/jacket/provider/esign/callback` with an HMAC. Neither has a staff
 * session, so neither is here.
 *
 * BYTES LEAVE THROUGH A GRANT. Staff never GET a document by id: they POST for
 * a grant, receive a fifteen-minute token, and fetch through
 * `/api/jacket/artifacts/:grantToken`, which is unauthenticated by middleware
 * because the token is the credential — the same shape as the signer lane.
 *
 * NOTHING HERE ASKS ANYBODY TO TYPE AN IDENTIFIER. `/find/approved` is the list
 * the console opens a jacket from, and every other id comes from a record the
 * caller already has on screen.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  assemblePackageWithin,
  certificateForStaff,
  CONSENT_TEXT,
  CONSENT_TEXT_VERSION,
  exportJacket,
  INTENT_STATEMENT,
  issueArtifactGrant,
  jacketBoard,
  jacketDetail,
  liftLegalHold,
  listConfiguration,
  markReviewReady,
  openableDeskingCases,
  openJacketWithin,
  packageDetail,
  placeLegalHold,
  recordRequirementWithin,
  recordRetentionPolicyWithin,
  recordTemplateWithin,
  redeemArtifactGrant,
  reviewPackage,
  satisfyWithEvidence,
  sendPackage,
  signAsDealerRepresentative,
  templateSummary,
  voidJacket,
  voidPackage,
  waiveRequirement,
  type ConfiguredTransactionType,
  type DocumentKind,
  type SignerRole,
  type TemplateApprovalStatus,
} from '@dealer/jacket';
import { requestFingerprint, runIdempotentAdminCommand } from '@dealer/identity-access';
import type { Executor } from '@dealer/database';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '@dealer/platform';
import {
  authenticate,
  rejectTenantOverride,
  requireAction,
  requireContext,
} from '../middleware/auth';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANE_TOKEN_RE = /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{32,64}$/i;

interface Body {
  [key: string]: unknown;
}

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
    throw new ForbiddenError('The deal jacket surface is tenant-scoped', {
      code: 'tenant_required',
    });
  }
  return ctx.tenantId;
}

function actorOf(req: Request): string {
  return requireContext(req).userId;
}

function body(req: Request): Body {
  return (req.body ?? {}) as Body;
}

function requireUuidParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !UUID_RE.test(value))
    throw new NotFoundError('Resource not found');
  return value;
}

function requireUuidField(b: Body, name: string): string {
  const value = b[name];
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new ValidationError(`${name} must name a record you selected`, {
      code: 'selection_required',
    });
  }
  return value;
}

function optionalUuidField(b: Body, name: string): string | null {
  const value = b[name];
  if (value === undefined || value === null || value === '') return null;
  return requireUuidField(b, name);
}

function stringField(b: Body, name: string, required: boolean): string | null {
  const value = b[name];
  if (typeof value === 'string' && value.trim().length > 0) return value;
  if (required) throw new ValidationError(`${name} is required`, { code: 'invalid_request' });
  return null;
}

function intField(b: Body, name: string, required: boolean): number | null {
  const value = b[name];
  if (value === undefined || value === null || value === '') {
    if (required) throw new ValidationError(`${name} is required`, { code: 'invalid_request' });
    return null;
  }
  const n = Number(value);
  if (!Number.isInteger(n))
    throw new ValidationError(`${name} is a whole number`, { code: 'invalid_request' });
  return n;
}

function boolField(b: Body, name: string, fallback: boolean): boolean {
  const value = b[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean')
    throw new ValidationError(`${name} is true or false`, { code: 'invalid_request' });
  return value;
}

function expectedVersionOf(req: Request): number {
  const raw = body(req).expected_version;
  if (!Number.isInteger(Number(raw))) {
    throw new ValidationError('expected_version is required', {
      code: 'expected_version_required',
    });
  }
  return Number(raw);
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

/** Every bigint becomes a decimal string; it runs INSIDE the idempotent work. */
function serialise(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serialise);
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Map) return serialise(Object.fromEntries(value));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serialise(v);
    return out;
  }
  return value;
}

function send(res: Response, status: number, payload: Record<string, unknown>): void {
  res.status(status).json(serialise(payload) as Record<string, unknown>);
}

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
  res.status(outcome.status).json(serialise(outcome.body) as Record<string, unknown>);
}

/** A service's refusal, turned into the problem the caller should see. */
function refuse(outcome: { outcome: string } & Record<string, unknown>): never {
  switch (outcome.outcome) {
    case 'not_found':
      throw new NotFoundError('Resource not found');
    case 'version_conflict':
      throw new ConflictError('This record changed since you loaded it — reload and retry', {
        code: 'version_conflict',
        details: { current_version: outcome.currentVersion as number },
      });
    case 'stale_source':
      throw new ConflictError(
        'the desk no longer stands behind the version this jacket was opened from — void the jacket and open a new one',
        {
          code: 'desking_approval_moved',
          details: {
            bound_version_no: outcome.boundVersionNo as number,
            current_version_no: outcome.currentVersionNo as number | null,
          },
        },
      );
    case 'blocked':
      throw new UnprocessableError('required items are still missing from the checklist', {
        code: 'checklist_incomplete',
        details: { items: serialise(outcome.items) },
      });
    case 'render_failed':
      throw new UnprocessableError('the package could not be rendered', {
        code: 'render_failure',
        details: { failures: outcome.failures, package: serialise(outcome.package) },
      });
    case 'not_approved':
      throw new UnprocessableError(String(outcome.error), { code: 'desking_not_approved' });
    case 'overlaps':
      throw new ConflictError(String(outcome.error), { code: 'configuration_overlap' });
    case 'hash_mismatch':
      throw new ConflictError('the package you were shown is not the package this ceremony binds', {
        code: 'package_hash_mismatch',
      });
    case 'out_of_order':
      throw new ConflictError('another signer signs before you', { code: 'signing_out_of_order' });
    case 'consent_required':
      throw new UnprocessableError('consent to electronic records comes before a signature', {
        code: 'consent_required',
      });
    case 'closed':
      throw new ConflictError(`this signing ceremony is ${String(outcome.state)}`, {
        code: 'ceremony_closed',
      });
    case 'expired':
      throw new UnprocessableError('this signing ceremony has expired', {
        code: 'signing_link_expired',
      });
    case 'not_complete':
      throw new UnprocessableError('this ceremony has not completed; there is no certificate yet', {
        code: 'ceremony_not_complete',
      });
    case 'invalid':
      throw new UnprocessableError(String(outcome.error), { code: 'invalid_request' });
    default:
      throw new UnprocessableError('the command was refused', { code: 'refused' });
  }
}

// ── discovery and reading ───────────────────────────────────────────────────

router.get(
  '/find/approved',
  authenticate,
  requireAction('jacket.discovery.read'),
  handler(async (req, res) => {
    send(res, 200, { cases: await openableDeskingCases(tenantOf(req), actorOf(req)) });
  }),
);

router.get(
  '/board',
  authenticate,
  requireAction('jacket.board.view'),
  handler(async (req, res) => {
    send(res, 200, { board: await jacketBoard(tenantOf(req), actorOf(req)) });
  }),
);

router.get(
  '/jackets/:jacketId',
  authenticate,
  requireAction('jacket.read'),
  handler(async (req, res) => {
    const detail = await jacketDetail(
      tenantOf(req),
      actorOf(req),
      requireUuidParam(req, 'jacketId'),
    );
    if (detail === null) throw new NotFoundError('Resource not found');
    send(res, 200, { jacket: detail });
  }),
);

router.get(
  '/packages/:packageId',
  authenticate,
  requireAction('jacket.package.read'),
  handler(async (req, res) => {
    const detail = await packageDetail(
      tenantOf(req),
      actorOf(req),
      requireUuidParam(req, 'packageId'),
    );
    if (detail === null) throw new NotFoundError('Resource not found');
    send(res, 200, { package: detail });
  }),
);

router.get(
  '/ceremonies/:ceremonyId/certificate',
  authenticate,
  requireAction('jacket.ceremony.read'),
  handler(async (req, res) => {
    const found = await certificateForStaff({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      ceremonyId: requireUuidParam(req, 'ceremonyId'),
    });
    if (found.outcome !== 'ok') refuse(found);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Content-Sha256', found.ceremony.completionCertificateSha256 ?? '');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(found.content);
  }),
);

// ── the jacket ──────────────────────────────────────────────────────────────

router.post(
  '/jackets',
  authenticate,
  requireAction('jacket.open'),
  handler(async (req, res) => {
    const b = body(req);
    await idempotent(req, res, async (tx) => {
      const opened = await openJacketWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        deskingCaseId: requireUuidField(b, 'desking_case_id'),
      });
      if (opened.outcome === 'already_open') {
        return { status: 200, body: serialise({ jacket: opened.jacket, outcome: 'already_open' }) };
      }
      if (opened.outcome !== 'opened') refuse(opened);
      return { status: 201, body: serialise({ jacket: opened.jacket }) };
    });
  }),
);

router.post(
  '/jackets/:jacketId/checklist/:itemId/evidence',
  authenticate,
  requireAction('jacket.checklist.evidence'),
  handler(async (req, res) => {
    const b = body(req);
    const updated = await satisfyWithEvidence({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      jacketId: requireUuidParam(req, 'jacketId'),
      itemId: requireUuidParam(req, 'itemId'),
      evidenceUri: String(stringField(b, 'evidence_uri', true)),
      evidenceSha256: String(stringField(b, 'evidence_sha256', true)),
      expectedVersion: expectedVersionOf(req),
    });
    if (updated.outcome === 'already_there') {
      send(res, 200, { item: updated.item, outcome: 'already_there' });
      return;
    }
    if (updated.outcome !== 'updated') refuse(updated);
    send(res, 200, { item: updated.item });
  }),
);

router.post(
  '/jackets/:jacketId/checklist/:itemId/waiver',
  authenticate,
  requireAction('jacket.checklist.waive'),
  handler(async (req, res) => {
    const b = body(req);
    const waived = await waiveRequirement({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      jacketId: requireUuidParam(req, 'jacketId'),
      itemId: requireUuidParam(req, 'itemId'),
      reason: String(stringField(b, 'reason', true)),
      policyVersion: intField(b, 'policy_version', true) ?? 0,
      evidenceUri: String(stringField(b, 'evidence_uri', true)),
      expectedVersion: expectedVersionOf(req),
    });
    if (waived.outcome === 'already_there') {
      send(res, 200, { item: waived.item, outcome: 'already_there' });
      return;
    }
    if (waived.outcome !== 'updated') refuse(waived);
    send(res, 200, { item: waived.item });
  }),
);

router.post(
  '/jackets/:jacketId/void',
  authenticate,
  requireAction('jacket.void'),
  handler(async (req, res) => {
    const voided = await voidJacket({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      jacketId: requireUuidParam(req, 'jacketId'),
      reason: String(stringField(body(req), 'reason', true)),
      expectedVersion: expectedVersionOf(req),
    });
    if (voided.outcome === 'already_there') {
      send(res, 200, { jacket: voided.jacket, outcome: 'already_there' });
      return;
    }
    if (voided.outcome !== 'moved') refuse(voided);
    send(res, 200, { jacket: voided.jacket });
  }),
);

// ── the package ─────────────────────────────────────────────────────────────

router.post(
  '/jackets/:jacketId/packages',
  authenticate,
  requireAction('jacket.package.assemble'),
  handler(async (req, res) => {
    const jacketId = requireUuidParam(req, 'jacketId');
    const expectedVersion = expectedVersionOf(req);
    await idempotent(req, res, async (tx) => {
      const assembled = await assemblePackageWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        jacketId,
        expectedVersion,
      });
      if (assembled.outcome === 'already_current') {
        return {
          status: 200,
          body: serialise({
            package: assembled.package,
            documents: assembled.documents,
            outcome: 'already_current',
          }),
        };
      }
      if (assembled.outcome !== 'assembled') refuse(assembled);
      return {
        status: 201,
        body: serialise({
          package: assembled.package,
          documents: assembled.documents,
          superseded_package_id: assembled.supersededPackageId,
        }),
      };
    });
  }),
);

router.post(
  '/packages/:packageId/review-ready',
  authenticate,
  requireAction('jacket.package.review_ready'),
  handler(async (req, res) => {
    const moved = await markReviewReady({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      packageId: requireUuidParam(req, 'packageId'),
      expectedVersion: expectedVersionOf(req),
    });
    if (moved.outcome === 'already_there') {
      send(res, 200, { package: moved.package, outcome: 'already_there' });
      return;
    }
    if (moved.outcome !== 'moved') refuse(moved);
    send(res, 200, { package: moved.package });
  }),
);

router.post(
  '/packages/:packageId/review',
  authenticate,
  requireAction('jacket.package.review'),
  handler(async (req, res) => {
    const reviewed = await reviewPackage({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      packageId: requireUuidParam(req, 'packageId'),
      expectedVersion: expectedVersionOf(req),
    });
    if (reviewed.outcome === 'already_there') {
      send(res, 200, { package: reviewed.package, outcome: 'already_there' });
      return;
    }
    if (reviewed.outcome !== 'moved') refuse(reviewed);
    send(res, 200, { package: reviewed.package });
  }),
);

router.post(
  '/packages/:packageId/send',
  authenticate,
  requireAction('jacket.package.send'),
  handler(async (req, res) => {
    const sent = await sendPackage({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      packageId: requireUuidParam(req, 'packageId'),
      expectedVersion: expectedVersionOf(req),
    });
    if (sent.outcome === 'already_sent') {
      send(res, 200, {
        package: sent.package,
        ceremony: sent.ceremony,
        signers: sent.signers,
        outcome: 'already_sent',
      });
      return;
    }
    if (sent.outcome !== 'sent') refuse(sent);
    // NO SIGNING LINK IN THIS RESPONSE. The customer's link went to the provider.
    send(res, 200, { package: sent.package, ceremony: sent.ceremony, signers: sent.signers });
  }),
);

router.post(
  '/packages/:packageId/void',
  authenticate,
  requireAction('jacket.package.void'),
  handler(async (req, res) => {
    const voided = await voidPackage({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      packageId: requireUuidParam(req, 'packageId'),
      reason: String(stringField(body(req), 'reason', true)),
      expectedVersion: expectedVersionOf(req),
    });
    if (voided.outcome === 'already_there') {
      send(res, 200, { package: voided.package, outcome: 'already_there' });
      return;
    }
    if (voided.outcome !== 'moved') refuse(voided);
    send(res, 200, { package: voided.package });
  }),
);

router.post(
  '/packages/:packageId/documents/:documentId/access',
  authenticate,
  requireAction('jacket.artifact.access'),
  handler(async (req, res) => {
    const granted = await issueArtifactGrant({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      packageId: requireUuidParam(req, 'packageId'),
      documentId: requireUuidParam(req, 'documentId'),
    });
    if (granted.outcome !== 'granted') refuse(granted);
    send(res, 201, { grant: granted.grant });
  }),
);

/**
 * THE DOOR. Unauthenticated by middleware because the grant token is the
 * credential: random, stored only as a digest, fifteen minutes long, counted.
 */
router.get('/artifacts/:grantToken', (req: Request, res: Response, next: NextFunction): void => {
  (async () => {
    const token = String(req.params.grantToken ?? '');
    if (!LANE_TOKEN_RE.test(token)) throw new NotFoundError('Resource not found');
    const redeemed = await redeemArtifactGrant(token);
    if (redeemed.outcome === 'expired') {
      throw new UnprocessableError('this document link has expired — ask for a new one', {
        code: 'artifact_grant_expired',
      });
    }
    if (redeemed.outcome !== 'ok') throw new NotFoundError('Resource not found');
    res.setHeader('Content-Type', redeemed.document.mimeType);
    res.setHeader('Content-Length', String(redeemed.content.byteLength));
    res.setHeader('X-Content-Sha256', redeemed.document.contentSha256);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(redeemed.content);
  })().catch(next);
});

// ── the ceremony ────────────────────────────────────────────────────────────

router.post(
  '/ceremonies/:ceremonyId/dealer-signature',
  authenticate,
  requireAction('jacket.ceremony.sign_as_dealer'),
  handler(async (req, res) => {
    const b = body(req);
    const signed = await signAsDealerRepresentative({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      ceremonyId: requireUuidParam(req, 'ceremonyId'),
      packageSha256: String(stringField(b, 'package_sha256', true)),
      intentStatement: String(stringField(b, 'intent_statement', true)),
      consentTextVersion: String(stringField(b, 'consent_text_version', true)),
    });
    if (signed.outcome === 'already_signed') {
      send(res, 200, { signer: signed.signer, outcome: 'already_signed' });
      return;
    }
    if (signed.outcome !== 'signed') refuse(signed);
    send(res, 200, {
      signer: signed.signer,
      ceremony: signed.ceremony,
      package: signed.package,
      completed: signed.completed,
    });
  }),
);

/** The consent and intent wording a staff signer confirms; the page shows exactly this. */
router.get(
  '/ceremonies/:ceremonyId/signing-terms',
  authenticate,
  requireAction('jacket.ceremony.read'),
  handler(async (_req, res) => {
    send(res, 200, {
      consent_text: CONSENT_TEXT,
      consent_text_version: CONSENT_TEXT_VERSION,
      intent_statement: INTENT_STATEMENT,
    });
  }),
);

// ── configuration ───────────────────────────────────────────────────────────

router.get(
  '/configuration',
  authenticate,
  requireAction('jacket.configuration.read'),
  handler(async (req, res) => {
    send(res, 200, { configuration: await listConfiguration(tenantOf(req), actorOf(req)) });
  }),
);

router.post(
  '/configuration/templates',
  authenticate,
  requireAction('jacket.configuration.write'),
  handler(async (req, res) => {
    const b = body(req);
    const roles = Array.isArray(b.required_signer_roles)
      ? (b.required_signer_roles as unknown[]).filter((r): r is string => typeof r === 'string')
      : ['customer'];
    await idempotent(req, res, async (tx) => {
      const recorded = await recordTemplateWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        templateCode: String(stringField(b, 'template_code', true)),
        title: String(stringField(b, 'title', true)),
        documentKind: String(stringField(b, 'document_kind', true)) as DocumentKind,
        jurisdiction: String(stringField(b, 'jurisdiction', true)),
        legalEntityId: optionalUuidField(b, 'legal_entity_id'),
        rooftopId: optionalUuidField(b, 'location_id') ?? optionalUuidField(b, 'rooftop_id'),
        transactionType: (stringField(b, 'transaction_type', false) ??
          'any') as ConfiguredTransactionType,
        source: String(stringField(b, 'source', true)),
        approvalStatus: (stringField(b, 'approval_status', false) ??
          'unapproved_sample') as TemplateApprovalStatus,
        approvalReference: stringField(b, 'approval_reference', false),
        effectiveFrom: String(stringField(b, 'effective_from', true)),
        effectiveTo: stringField(b, 'effective_to', false),
        bodyTemplate: String(stringField(b, 'body_template', true)),
        requiredSignerRoles: roles as SignerRole[],
        closesPredecessor: boolField(b, 'closes_predecessor', false),
      });
      if (recorded.outcome !== 'recorded') refuse(recorded);
      return { status: 201, body: serialise({ template: templateSummary(recorded.record) }) };
    });
  }),
);

router.post(
  '/configuration/requirements',
  authenticate,
  requireAction('jacket.configuration.write'),
  handler(async (req, res) => {
    const b = body(req);
    await idempotent(req, res, async (tx) => {
      const recorded = await recordRequirementWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        requirementCode: String(stringField(b, 'requirement_code', true)),
        label: String(stringField(b, 'label', true)),
        jurisdiction: String(stringField(b, 'jurisdiction', true)),
        legalEntityId: optionalUuidField(b, 'legal_entity_id'),
        rooftopId: optionalUuidField(b, 'location_id') ?? optionalUuidField(b, 'rooftop_id'),
        transactionType: (stringField(b, 'transaction_type', false) ??
          'any') as ConfiguredTransactionType,
        satisfiedBy: String(stringField(b, 'satisfied_by', true)) as 'template' | 'evidence',
        templateCode: stringField(b, 'template_code', false),
        evidenceKind: stringField(b, 'evidence_kind', false),
        required: boolField(b, 'required', true),
        waivable: boolField(b, 'waivable', false),
        source: String(stringField(b, 'source', true)),
        effectiveFrom: String(stringField(b, 'effective_from', true)),
        effectiveTo: stringField(b, 'effective_to', false),
        closesPredecessor: boolField(b, 'closes_predecessor', false),
      });
      if (recorded.outcome !== 'recorded') refuse(recorded);
      return { status: 201, body: serialise({ requirement: recorded.record }) };
    });
  }),
);

// ── the support lane ────────────────────────────────────────────────────────

router.post(
  '/configuration/retention-policies',
  authenticate,
  requireAction('jacket.retention.write'),
  handler(async (req, res) => {
    const b = body(req);
    await idempotent(req, res, async (tx) => {
      const recorded = await recordRetentionPolicyWithin(tx, {
        actingUserLinkId: actorOf(req),
        tenantId: tenantOf(req),
        policyCode: String(stringField(b, 'policy_code', true)),
        label: String(stringField(b, 'label', true)),
        retainForDays: intField(b, 'retain_for_days', true) ?? 0,
        source: String(stringField(b, 'source', true)),
        effectiveFrom: String(stringField(b, 'effective_from', true)),
        effectiveTo: stringField(b, 'effective_to', false),
      });
      if (recorded.outcome !== 'recorded') refuse(recorded);
      return { status: 201, body: serialise({ retention_policy: recorded.record }) };
    });
  }),
);

router.post(
  '/jackets/:jacketId/legal-hold',
  authenticate,
  requireAction('jacket.hold.write'),
  handler(async (req, res) => {
    const b = body(req);
    const action = String(stringField(b, 'action', true));
    if (action !== 'place' && action !== 'lift') {
      throw new ValidationError('a legal hold is placed or lifted', { code: 'invalid_request' });
    }
    const input = {
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      jacketId: requireUuidParam(req, 'jacketId'),
      reason: String(stringField(b, 'reason', true)),
      reference: stringField(b, 'reference', false),
      expectedVersion: expectedVersionOf(req),
    };
    const held = action === 'place' ? await placeLegalHold(input) : await liftLegalHold(input);
    if (held.outcome === 'already_there') {
      send(res, 200, { jacket: held.jacket, outcome: 'already_there' });
      return;
    }
    if (held.outcome !== 'recorded') refuse(held);
    send(res, 200, { jacket: held.jacket, documents_affected: held.documentsAffected });
  }),
);

router.get(
  '/jackets/:jacketId/export',
  authenticate,
  requireAction('jacket.export.read'),
  handler(async (req, res) => {
    const exported = await exportJacket({
      actingUserLinkId: actorOf(req),
      tenantId: tenantOf(req),
      jacketId: requireUuidParam(req, 'jacketId'),
    });
    if (exported.outcome !== 'exported') refuse(exported);
    send(res, 200, { export: exported.export });
  }),
);

export default router;
