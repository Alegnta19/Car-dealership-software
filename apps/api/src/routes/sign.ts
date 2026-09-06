/**
 * FBL-140 — THE CUSTOMER SIGNER'S LANE (/sign/api).
 *
 * The customer is not a dealership user. They have no WorkOS identity, no
 * session cookie, no role binding and no catalog action, and this router has
 * no `authenticate` — the ONE credential on this lane is the token the
 * provider delivered to them, carried in the path, resolved to a signer row by
 * digest, and refused after its clock.
 *
 * EVERY REFUSAL IS THE SAME SHAPE. A token that never existed, a token that
 * belongs to another dealership, and a mistyped token all answer 404 in the
 * same words; an expired one says `expired`, because the person holding it
 * needs to ask for a new link and nothing about that discloses anything.
 *
 * THE PAGE SENDS BACK THE HASH IT SHOWED. `package_sha256` on the signature
 * request is the digest the signer's page displayed; the service compares it
 * to the ceremony's bound digest and the database compares the package's
 * digest again. A page that showed one package cannot sign another.
 *
 * The JSON API is under `/sign/api`; the page itself is served as a static
 * file at `/sign/` by app.ts, same-origin, so the token never crosses hosts.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import {
  consentToElectronicRecords,
  declineAsCustomer,
  openSignerSession,
  signAsCustomer,
  signerDocumentContent,
  type SignerLaneOutcome,
  type SignerSession,
} from '@dealer/jacket';
import {
  ConflictError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '@dealer/platform';

const router = Router();

interface Body {
  [key: string]: unknown;
}

function handler(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

const LANE_TOKEN_RE = /^[0-9a-f-]{36}\.[A-Za-z0-9_-]{32,64}$/i;

function tokenOf(req: Request): string {
  const value = req.params.token;
  if (typeof value !== 'string' || !LANE_TOKEN_RE.test(value))
    throw new NotFoundError('Resource not found');
  return value;
}

function serialise(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serialise);
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = serialise(v);
    return out;
  }
  return value;
}

/** What the signer's page may know. Provenance ids, other signers' contacts and internal ids stay out. */
function sessionBody(session: SignerSession): Record<string, unknown> {
  return {
    signer: {
      signerId: session.signer.signerId,
      role: session.signer.signerRole,
      displayName: session.signer.displayName,
      state: session.signer.state,
      consentedAt: session.signer.consentedAt,
      signedAt: session.signer.signedAt,
      signatureSha256: session.signer.signatureSha256,
      tokenExpiresAt: session.signer.tokenExpiresAt,
    },
    ceremony: {
      ceremonyId: session.ceremony.ceremonyId,
      state: session.ceremony.state,
      boundPackageSha256: session.ceremony.boundPackageSha256,
      providerKind: session.ceremony.providerKind,
      expiresAt: session.ceremony.expiresAt,
      completedAt: session.ceremony.completedAt,
      completionCertificateSha256: session.ceremony.completionCertificateSha256,
    },
    package: {
      packageId: session.package.packageId,
      versionNo: session.package.versionNo,
      state: session.package.state,
      packageSha256: session.package.packageSha256,
      documentCount: session.package.documentCount,
      carriesUnapprovedTemplates: session.package.carriesUnapprovedTemplates,
    },
    signers: session.signers.map((s) => ({
      role: s.signerRole,
      signingOrder: s.signingOrder,
      state: s.state,
      signedAt: s.signedAt,
    })),
    documents: session.documents.map((d) => ({
      documentId: d.documentId,
      sequenceNo: d.sequenceNo,
      title: d.title,
      documentKind: d.documentKind,
      contentSha256: d.contentSha256,
      byteSize: d.byteSize,
      mimeType: d.mimeType,
      templateApprovalStatus: d.templateApprovalStatus,
    })),
    fields: session.fields,
    consentText: session.consentText,
    consentTextVersion: session.consentTextVersion,
    intentStatement: session.intentStatement,
    nextStep: session.nextStep,
  };
}

function unwrap<T>(outcome: SignerLaneOutcome<T>): T {
  switch (outcome.outcome) {
    case 'ok':
      return outcome.value;
    case 'expired':
      throw new UnprocessableError(
        'this signing link has expired — ask the dealership for a new one',
        {
          code: 'signing_link_expired',
        },
      );
    case 'closed':
      throw new ConflictError(
        `this signing ceremony is ${outcome.state} and takes no further action`,
        {
          code: 'ceremony_closed',
          details: { state: outcome.state },
        },
      );
    case 'invalid':
      throw new UnprocessableError(outcome.error, { code: 'invalid_request' });
    case 'not_found':
    default:
      throw new NotFoundError('Resource not found');
  }
}

router.get(
  '/:token',
  handler(async (req, res) => {
    const session = unwrap(await openSignerSession(tokenOf(req)));
    res.status(200).json(serialise(sessionBody(session)));
  }),
);

router.get(
  '/:token/documents/:documentId',
  handler(async (req, res) => {
    const documentId = String(req.params.documentId ?? '');
    if (!/^[0-9a-f-]{36}$/i.test(documentId)) throw new NotFoundError('Resource not found');
    const found = unwrap(await signerDocumentContent(tokenOf(req), documentId));
    res.setHeader('Content-Type', found.document.mimeType);
    res.setHeader('Content-Length', String(found.content.byteLength));
    res.setHeader('X-Content-Sha256', found.document.contentSha256);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).end(found.content);
  }),
);

router.post(
  '/:token/consent',
  handler(async (req, res) => {
    const b = (req.body ?? {}) as Body;
    const version = typeof b.consent_text_version === 'string' ? b.consent_text_version : '';
    if (version.length === 0) {
      throw new ValidationError('consent names the version of the text that was read', {
        code: 'consent_version_required',
      });
    }
    const session = unwrap(await consentToElectronicRecords(tokenOf(req), version));
    res.status(200).json(serialise(sessionBody(session)));
  }),
);

router.post(
  '/:token/signature',
  handler(async (req, res) => {
    const b = (req.body ?? {}) as Body;
    const packageSha256 = typeof b.package_sha256 === 'string' ? b.package_sha256 : '';
    const intent = typeof b.intent_statement === 'string' ? b.intent_statement : '';
    if (!/^[0-9a-f]{64}$/.test(packageSha256)) {
      throw new ValidationError('a signature names the package hash the page displayed', {
        code: 'package_hash_required',
      });
    }
    const signed = await signAsCustomer(tokenOf(req), { packageSha256, intentStatement: intent });
    switch (signed.outcome) {
      case 'signed':
        res.status(200).json(
          serialise({
            signer: {
              state: signed.signer.state,
              signedAt: signed.signer.signedAt,
              signatureSha256: signed.signer.signatureSha256,
            },
            ceremony: {
              state: signed.ceremony.state,
              completionCertificateSha256: signed.ceremony.completionCertificateSha256,
            },
            package: { state: signed.package.state, packageSha256: signed.package.packageSha256 },
            completed: signed.completed,
          }),
        );
        return;
      case 'already_signed':
        res.status(200).json(
          serialise({
            signer: { state: 'signed', signedAt: signed.signer.signedAt },
            outcome: 'already_signed',
          }),
        );
        return;
      case 'consent_required':
        throw new UnprocessableError('consent to electronic records comes before a signature', {
          code: 'consent_required',
        });
      case 'out_of_order':
        throw new ConflictError('another signer signs before you', {
          code: 'signing_out_of_order',
        });
      case 'hash_mismatch':
        throw new ConflictError(
          'the package you were shown is not the package this ceremony binds',
          {
            code: 'package_hash_mismatch',
          },
        );
      case 'closed':
        throw new ConflictError(`this signing ceremony is ${signed.state}`, {
          code: 'ceremony_closed',
        });
      case 'expired':
        throw new UnprocessableError('this signing link has expired', {
          code: 'signing_link_expired',
        });
      case 'invalid':
        throw new UnprocessableError(signed.error, { code: 'invalid_request' });
      case 'not_found':
      default:
        throw new NotFoundError('Resource not found');
    }
  }),
);

router.post(
  '/:token/decline',
  handler(async (req, res) => {
    const b = (req.body ?? {}) as Body;
    const reason = typeof b.reason === 'string' ? b.reason : '';
    const declined = await declineAsCustomer(tokenOf(req), reason);
    switch (declined.outcome) {
      case 'declined':
      case 'already_declined':
        res
          .status(200)
          .json(serialise({ signer: { state: declined.signer.state }, outcome: declined.outcome }));
        return;
      case 'closed':
        throw new ConflictError(`this signing ceremony is ${declined.state}`, {
          code: 'ceremony_closed',
        });
      case 'expired':
        throw new UnprocessableError('this signing link has expired', {
          code: 'signing_link_expired',
        });
      case 'invalid':
        throw new UnprocessableError(declined.error, { code: 'invalid_request' });
      case 'not_found':
      default:
        throw new NotFoundError('Resource not found');
    }
  }),
);

export default router;
