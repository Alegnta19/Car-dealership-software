import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';

import { closePool, query } from '@dealer/database';
import { createApp, resetAuthRoutesForTests, resetIdentityCompositionForTests } from '@dealer/api';
import {
  CONSENT_TEXT_VERSION,
  INTENT_STATEMENT,
  redeemArtifactGrant,
  resetSimulatedEsignProviderForTests,
  signProviderBody,
  simulatedDeliveries,
} from '@dealer/jacket';
import { resetConfigForTests } from '@dealer/platform';
import {
  resetDatabase,
  skipIntegration,
  startIdentityTestEnv,
  type IdentityTestEnv,
} from '@dealer/test-kit';

import {
  INSURANCE_CARD_SHA256,
  resetVins,
  seedJacketWorld,
  type JacketWorld,
} from './jacket-world';

/**
 * OUTCOME 7 — AUTHORIZATION, ISOLATION AND PRIVACY, AT THE SURFACE PEOPLE REACH.
 *
 * "Enforce tenant and rooftop RLS, tenant-qualified parent binding,
 * non-disclosing authorization, optimistic concurrency, idempotency,
 * audit/outbox atomicity, short-lived artifact access, PII-safe logs/events,
 * retention, export, and legal holds. Sales staff, managers, customer signers,
 * support actors, and system/provider callbacks must use distinct authority
 * lanes."
 *
 * WHY THIS BATTERY DRIVES HTTP. The service batteries prove what the services
 * do; this one proves that the ROUTES declare the right action and carry the
 * right parameter, that the FIVE LANES are five different doors, and that each
 * door refuses in the words a person on the wrong side of it should get.
 *
 * EVERY REFUSAL IS CHECKED FOR WHAT IT DOES NOT SAY, and every parent-binding
 * 404 is paired with the same request through the right parent, so a refusal
 * cannot be a mistyped URL.
 */
const WEBHOOK_SECRET = ['fbl140', 'webhook', 'secret', 'for', 'tests', '0123456789abcdef'].join(
  '-',
);

/**
 * Reads one dotted path off a JSON response body. The tests assert on whatever
 * they find there, the way a client would, without pretending to know the shape.
 */
function pick(body: Record<string, unknown> | null, path: string): unknown {
  let current: unknown = body;
  for (const key of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

describe(
  'jacket: five lanes, parentage, privacy and the absence of a sale (FBL-140 Outcome 7)',
  { skip: skipIntegration ? 'set TEST_DATABASE_URL to run' : false },
  () => {
    let server: Server;
    let base: string;
    let env: IdentityTestEnv;

    before(async () => {
      env = await startIdentityTestEnv();
      process.env.ESIGN_WEBHOOK_SECRET = WEBHOOK_SECRET;
      resetConfigForTests();
      resetIdentityCompositionForTests();
      resetAuthRoutesForTests();
      server = createApp().listen(0);
      await new Promise<void>((resolve) => server.once('listening', () => resolve()));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(async () => {
      delete process.env.ESIGN_WEBHOOK_SECRET;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await env.stop();
      await closePool();
    });

    beforeEach(async () => {
      await resetDatabase();
      resetVins();
      resetSimulatedEsignProviderForTests();
    });

    async function call(
      token: string | null,
      method: string,
      path: string,
      payload?: unknown,
      extraHeaders: Record<string, string> = {},
    ): Promise<{
      status: number;
      body: Record<string, unknown> | null;
      headers: Headers;
      text: string;
    }> {
      const res = await fetch(base + path, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...extraHeaders,
        },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      const text = await res.text();
      let body: Record<string, unknown> | null;
      try {
        body = text ? (JSON.parse(text) as Record<string, unknown>) : null;
      } catch {
        body = null;
      }
      return { status: res.status, body, headers: res.headers, text };
    }

    interface Walk {
      w: JacketWorld;
      jacketId: string;
      jacketVersion: number;
      packageId: string;
      packageVersion: number;
      packageSha256: string;
      documentId: string;
      insuranceItem: { itemId: string; authorizationVersion: number };
    }

    /** A jacket opened and assembled, through HTTP, by the salesperson. */
    async function walkToAssembled(): Promise<Walk> {
      const w = await seedJacketWorld(env);
      const opened = await call(
        w.tokens.seller,
        'POST',
        '/api/jacket/jackets',
        { desking_case_id: w.caseId, location_id: w.rooftopId },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(opened.status, 201, opened.text);
      const jacket = pick(opened.body, 'jacket') as {
        jacketId: string;
        authorizationVersion: number;
      };
      const assembled = await call(
        w.tokens.seller,
        'POST',
        `/api/jacket/jackets/${jacket.jacketId}/packages`,
        { expected_version: jacket.authorizationVersion },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(assembled.status, 201, assembled.text);
      const pkg = pick(assembled.body, 'package') as {
        packageId: string;
        authorizationVersion: number;
        packageSha256: string;
      };
      const detail = await call(w.tokens.seller, 'GET', `/api/jacket/jackets/${jacket.jacketId}`);
      assert.equal(detail.status, 200, detail.text);
      const j = pick(detail.body, 'jacket') as {
        checklist: unknown;
        jacket: { authorizationVersion: number };
      };
      const insurance = (
        j.checklist as { requirementCode: string; itemId: string; authorizationVersion: number }[]
      ).find((i) => i.requirementCode === 'proof_of_insurance')!;
      return {
        w,
        jacketId: jacket.jacketId,
        jacketVersion: j.jacket.authorizationVersion,
        packageId: pkg.packageId,
        packageVersion: pkg.authorizationVersion,
        packageSha256: pkg.packageSha256,
        documentId: (pick(assembled.body, 'documents') as { documentId: string }[])[0]!.documentId,
        insuranceItem: insurance,
      };
    }

    /** …and sent for signature by the manager. */
    async function walkToSent(): Promise<Walk & { ceremonyId: string; customerToken: string }> {
      const x = await walkToAssembled();
      const evidence = await call(
        x.w.tokens.seller,
        'POST',
        `/api/jacket/jackets/${x.jacketId}/checklist/${x.insuranceItem.itemId}/evidence`,
        {
          evidence_uri: 'file://insurance-card.pdf',
          evidence_sha256: INSURANCE_CARD_SHA256,
          expected_version: x.insuranceItem.authorizationVersion,
        },
      );
      assert.equal(evidence.status, 200, evidence.text);
      const ready = await call(
        x.w.tokens.seller,
        'POST',
        `/api/jacket/packages/${x.packageId}/review-ready`,
        { expected_version: x.packageVersion },
      );
      assert.equal(ready.status, 200, ready.text);
      let v = pick(ready.body, 'package.authorizationVersion') as number;
      const reviewed = await call(
        x.w.tokens.manager,
        'POST',
        `/api/jacket/packages/${x.packageId}/review`,
        { expected_version: v },
      );
      assert.equal(reviewed.status, 200, reviewed.text);
      v = pick(reviewed.body, 'package.authorizationVersion') as number;
      const sent = await call(
        x.w.tokens.manager,
        'POST',
        `/api/jacket/packages/${x.packageId}/send`,
        { expected_version: v },
      );
      assert.equal(sent.status, 200, sent.text);
      assert.doesNotMatch(sent.text, /\/sign\/#\//, 'the staff response carries no signing link');
      const url = simulatedDeliveries().at(-1)!.signingUrl;
      return {
        ...x,
        packageVersion: pick(sent.body, 'package.authorizationVersion') as number,
        ceremonyId: pick(sent.body, 'ceremony.ceremonyId') as string,
        customerToken: url.split('#/')[1]!,
      };
    }

    test('a salesperson opens, assembles and readies; only a manager waives, reviews, sends and voids — and the refusal explains nothing', async () => {
      const x = await walkToAssembled();
      // Role denials on resource-typed actions answer 404, in the words a record the caller cannot see would get.
      const waive = await call(
        x.w.tokens.seller,
        'POST',
        `/api/jacket/jackets/${x.jacketId}/checklist/${x.insuranceItem.itemId}/waiver`,
        {
          reason: 'x',
          policy_version: 1,
          evidence_uri: 'file://x',
          expected_version: x.insuranceItem.authorizationVersion,
        },
      );
      assert.equal(waive.status, 404, waive.text);
      assert.doesNotMatch(
        waive.text,
        /role|forbidden|manager/i,
        'a role denial does not describe the role',
      );
      const review = await call(
        x.w.tokens.seller,
        'POST',
        `/api/jacket/packages/${x.packageId}/review`,
        { expected_version: x.packageVersion },
      );
      assert.equal(review.status, 404);
      const send = await call(
        x.w.tokens.seller,
        'POST',
        `/api/jacket/packages/${x.packageId}/send`,
        { expected_version: x.packageVersion },
      );
      assert.equal(send.status, 404);
      const voidPkg = await call(
        x.w.tokens.seller,
        'POST',
        `/api/jacket/packages/${x.packageId}/void`,
        { reason: 'x', expected_version: x.packageVersion },
      );
      assert.equal(voidPkg.status, 404);
      const voidJacket = await call(
        x.w.tokens.seller,
        'POST',
        `/api/jacket/jackets/${x.jacketId}/void`,
        { reason: 'x', expected_version: x.jacketVersion },
      );
      assert.equal(voidJacket.status, 404);
      // THE SAME REQUEST THROUGH A MANAGER SUCCEEDS, so the 404s above are role denials and not mistyped URLs.
      const waived = await call(
        x.w.tokens.manager,
        'POST',
        `/api/jacket/jackets/${x.jacketId}/checklist/${x.insuranceItem.itemId}/waiver`,
        {
          reason: 'binder to follow',
          policy_version: 3,
          evidence_uri: 'file://note.txt',
          expected_version: x.insuranceItem.authorizationVersion,
        },
      );
      assert.equal(waived.status, 200, waived.text);
      assert.equal(pick(waived.body, 'item.state'), 'waived');
    });

    test('the support lane is the administrator’s alone: retention, legal hold and export refuse a manager', async () => {
      const x = await walkToAssembled();
      // A resource-less admin action refuses a manager outright (there is no resource to hide behind).
      const retention = await call(
        x.w.tokens.manager,
        'POST',
        '/api/jacket/configuration/retention-policies',
        {
          policy_code: 'x_policy',
          label: 'x',
          retain_for_days: 10,
          source: 'x',
          effective_from: '2030-01-01T00:00:00.000Z',
        },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(retention.status, 403, retention.text);
      // Resource-typed admin actions refuse a manager in the words of a record they cannot see.
      const hold = await call(
        x.w.tokens.manager,
        'POST',
        `/api/jacket/jackets/${x.jacketId}/legal-hold`,
        { action: 'place', reason: 'litigation', expected_version: x.jacketVersion },
      );
      assert.equal(hold.status, 404, hold.text);
      const exported = await call(
        x.w.tokens.manager,
        'GET',
        `/api/jacket/jackets/${x.jacketId}/export`,
      );
      assert.equal(exported.status, 404);
      const bySeller = await call(
        x.w.tokens.seller,
        'GET',
        `/api/jacket/jackets/${x.jacketId}/export`,
      );
      assert.equal(bySeller.status, 404);

      // The administrator may, and the hold is history with a reason and a person.
      const placed = await call(
        x.w.tokens.admin,
        'POST',
        `/api/jacket/jackets/${x.jacketId}/legal-hold`,
        {
          action: 'place',
          reason: 'litigation hold — matter 2026-14',
          reference: 'M-2026-14',
          expected_version: x.jacketVersion,
        },
      );
      assert.equal(placed.status, 200, placed.text);
      assert.equal(pick(placed.body, 'documents_affected'), 3);
      const detail = await call(x.w.tokens.admin, 'GET', `/api/jacket/jackets/${x.jacketId}`);
      assert.equal(pick(detail.body, 'jacket.legalHold'), true);
      assert.ok(
        (pick(detail.body, 'jacket.packages.0.documents') as { legalHold: boolean }[]).every(
          (d) => d.legalHold === true,
        ),
      );
      assert.equal((pick(detail.body, 'jacket.retention') as unknown[]).length, 3);
      assert.equal(
        pick(detail.body, 'jacket.retention.0.disposal'),
        'NOT_YET_AVAILABLE',
        'nothing here deletes a document, and the record says so',
      );
      const lifted = await call(
        x.w.tokens.admin,
        'POST',
        `/api/jacket/jackets/${x.jacketId}/legal-hold`,
        {
          action: 'lift',
          reason: 'matter closed',
          expected_version: pick(placed.body, 'jacket.authorizationVersion'),
        },
      );
      assert.equal(lifted.status, 200, lifted.text);
      const history = await call(x.w.tokens.admin, 'GET', `/api/jacket/jackets/${x.jacketId}`);
      assert.deepEqual(
        (pick(history.body, 'jacket.legalHolds') as { action: string }[]).map((h) => h.action),
        ['placed', 'lifted'],
        'a lifted hold does not erase that it was placed',
      );

      const full = await call(x.w.tokens.admin, 'GET', `/api/jacket/jackets/${x.jacketId}/export`);
      assert.equal(full.status, 200, full.text);
      assert.equal((pick(full.body, 'export.packages') as unknown[]).length, 1);
      assert.equal((pick(full.body, 'export.legal_holds') as unknown[]).length, 2);
      const audit = await query(
        `SELECT event_type FROM audit_events WHERE tenant_id = $1 AND entity_id = $2 AND event_type = 'jacket.exported'`,
        [x.w.tenantId, x.jacketId],
      );
      assert.equal(audit.rows.length, 1, 'the export itself is in the audit trail');
    });

    test('a package is reached through its own id, and somebody else’s package, jacket or ceremony is not found', async () => {
      const a = await walkToSent();
      const b = await walkToSent();
      // The other dealership's rows, by their real ids.
      for (const path of [
        `/api/jacket/jackets/${b.jacketId}`,
        `/api/jacket/packages/${b.packageId}`,
        `/api/jacket/ceremonies/${b.ceremonyId}/certificate`,
      ]) {
        const foreign = await call(a.w.tokens.manager, 'GET', path);
        assert.equal(foreign.status, 404, `${path}: ${foreign.text}`);
      }
      // A checklist item under the WRONG jacket is not found; through the right one it is acted on.
      const wrongParent = await call(
        a.w.tokens.seller,
        'POST',
        `/api/jacket/jackets/${a.jacketId}/checklist/${b.insuranceItem.itemId}/evidence`,
        { evidence_uri: 'file://x', evidence_sha256: INSURANCE_CARD_SHA256, expected_version: 1 },
      );
      assert.equal(wrongParent.status, 404, wrongParent.text);
      // A document under the wrong package is not found; the right pairing grants.
      const wrongDoc = await call(
        a.w.tokens.seller,
        'POST',
        `/api/jacket/packages/${a.packageId}/documents/${b.documentId}/access`,
        {},
      );
      assert.equal(wrongDoc.status, 404);
      const rightDoc = await call(
        a.w.tokens.seller,
        'POST',
        `/api/jacket/packages/${a.packageId}/documents/${a.documentId}/access`,
        {},
      );
      assert.equal(rightDoc.status, 201, rightDoc.text);
      // The foreign salesperson at the other rooftop sees nothing on their board and nothing by id.
      // (A rooftop-scoped binding names its rooftop on a resource-less read, as every train's console does.)
      const board = await call(
        a.w.tokens.foreignSeller,
        'GET',
        `/api/jacket/board?location_id=${a.w.otherRooftopId}`,
      );
      assert.equal(board.status, 200);
      assert.deepEqual(pick(board.body, 'board.rows'), []);
      const byId = await call(a.w.tokens.foreignSeller, 'GET', `/api/jacket/jackets/${a.jacketId}`);
      assert.equal(byId.status, 404);
      const missing = await call(a.w.tokens.manager, 'GET', `/api/jacket/jackets/${randomUUID()}`);
      assert.equal(missing.status, 404);
      const nonsense = await call(a.w.tokens.manager, 'GET', `/api/jacket/jackets/not-a-uuid`);
      assert.equal(nonsense.status, 404);
    });

    test('a repeated command with one key is applied once and answered twice; a stale expected_version is a conflict', async () => {
      const w = await seedJacketWorld(env);
      const key = randomUUID();
      const first = await call(
        w.tokens.seller,
        'POST',
        '/api/jacket/jackets',
        { desking_case_id: w.caseId, location_id: w.rooftopId },
        { 'idempotency-key': key },
      );
      assert.equal(first.status, 201, first.text);
      const second = await call(
        w.tokens.seller,
        'POST',
        '/api/jacket/jackets',
        { desking_case_id: w.caseId, location_id: w.rooftopId },
        { 'idempotency-key': key },
      );
      assert.equal(second.status, 201);
      assert.equal(second.headers.get('idempotency-replayed'), 'true');
      assert.equal(pick(second.body, 'jacket.jacketId'), pick(first.body, 'jacket.jacketId'));
      const different = await call(
        w.tokens.seller,
        'POST',
        '/api/jacket/jackets',
        { desking_case_id: randomUUID(), location_id: w.rooftopId },
        { 'idempotency-key': key },
      );
      assert.equal(different.status, 422);
      assert.equal(pick(different.body, 'error.code'), 'idempotency_key_conflict');
      const count = await query(
        `SELECT COUNT(*)::int AS n FROM deal_jackets WHERE tenant_id = $1`,
        [w.tenantId],
      );
      assert.equal(Number((count.rows[0] as { n: number }).n), 1);

      const jacket = pick(first.body, 'jacket') as {
        jacketId: string;
        authorizationVersion: number;
      };
      const stale = await call(
        w.tokens.seller,
        'POST',
        `/api/jacket/jackets/${jacket.jacketId}/packages`,
        { expected_version: jacket.authorizationVersion + 7 },
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(stale.status, 409, stale.text);
      assert.equal(pick(stale.body, 'error.code'), 'version_conflict');
      assert.equal(pick(stale.body, 'error.details.current_version'), jacket.authorizationVersion);
      const none = await call(
        w.tokens.seller,
        'POST',
        `/api/jacket/jackets/${jacket.jacketId}/packages`,
        {},
        { 'idempotency-key': randomUUID() },
      );
      assert.equal(none.status, 400);
      assert.equal(pick(none.body, 'error.code'), 'expected_version_required');
    });

    test('a document leaves only through a short-lived grant, which is counted and then shut', async () => {
      const x = await walkToAssembled();
      const direct = await call(
        x.w.tokens.seller,
        'GET',
        `/api/jacket/packages/${x.packageId}/documents/${x.documentId}`,
      );
      assert.equal(direct.status, 404, 'there is no route that hands out bytes by document id');
      const granted = await call(
        x.w.tokens.seller,
        'POST',
        `/api/jacket/packages/${x.packageId}/documents/${x.documentId}/access`,
        {},
      );
      assert.equal(granted.status, 201, granted.text);
      const grant = pick(granted.body, 'grant') as {
        path: string;
        expiresAt: string;
        grantId: string;
      };
      assert.ok(
        Date.parse(grant.expiresAt) - Date.now() <= 15 * 60_000 + 5_000,
        'fifteen minutes, not a day',
      );
      const bytes = await fetch(base + grant.path);
      assert.equal(bytes.status, 200);
      assert.match(bytes.headers.get('content-type') ?? '', /text\/html/);
      assert.equal(bytes.headers.get('cache-control'), 'no-store');
      const html = await bytes.text();
      assert.match(html, /Dana Ortiz/);
      const stored = await query(
        `SELECT used_count, token_sha256 FROM artifact_access_grants WHERE tenant_id = $1 AND grant_id = $2`,
        [x.w.tenantId, grant.grantId],
      );
      assert.equal(
        Number((stored.rows[0] as { used_count: number }).used_count),
        1,
        'the read was counted',
      );
      assert.notEqual(
        String((stored.rows[0] as { token_sha256: string }).token_sha256),
        grant.path.split('/').at(-1)!.split('.')[1],
        'the database holds the digest, not the token',
      );
      // Past its clock, the same token opens nothing.
      const later = await redeemArtifactGrant(
        grant.path.split('/').at(-1)!,
        new Date(Date.parse(grant.expiresAt) + 1).toISOString(),
      );
      assert.equal(later.outcome, 'expired');
      const invented = await fetch(
        base + `/api/jacket/artifacts/${x.w.tenantId}.${'A'.repeat(43)}`,
      );
      assert.equal(invented.status, 404);
    });

    test('the customer’s lane is a token, not a session: it signs the exact package, and a staff token opens nothing on it', async () => {
      const x = await walkToSent();
      const opened = await call(null, 'GET', `/sign/api/${x.customerToken}`);
      assert.equal(opened.status, 200, opened.text);
      assert.equal(pick(opened.body, 'nextStep'), 'consent');
      assert.equal(pick(opened.body, 'package.packageSha256'), x.packageSha256);
      assert.ok(
        !('sourceId' in ((pick(opened.body, 'fields.0') as object | undefined) ?? {})),
        'the signer sees values, not provenance',
      );
      assert.doesNotMatch(
        opened.text,
        new RegExp(x.w.manager),
        'no staff identifier is shown to the customer',
      );

      // A staff bearer token on the customer's lane is meaningless, and a made-up lane token is not found.
      const staffOnLane = await call(
        x.w.tokens.manager,
        'GET',
        `/sign/api/${x.w.tenantId}.${'B'.repeat(43)}`,
      );
      assert.equal(staffOnLane.status, 404);
      // A customer token on the staff surface is not a credential at all.
      const laneOnStaff = await fetch(base + `/api/jacket/board`, {
        headers: { authorization: `Bearer ${x.customerToken}` },
      });
      assert.equal(laneOnStaff.status, 401);

      const early = await call(null, 'POST', `/sign/api/${x.customerToken}/signature`, {
        package_sha256: x.packageSha256,
        intent_statement: INTENT_STATEMENT,
      });
      assert.equal(early.status, 422);
      assert.equal(pick(early.body, 'error.code'), 'consent_required');
      const consented = await call(null, 'POST', `/sign/api/${x.customerToken}/consent`, {
        consent_text_version: CONSENT_TEXT_VERSION,
      });
      assert.equal(consented.status, 200, consented.text);
      assert.equal(pick(consented.body, 'nextStep'), 'sign');
      const doc = await fetch(
        base +
          `/sign/api/${x.customerToken}/documents/${String(pick(opened.body, 'documents.0.documentId'))}`,
      );
      assert.equal(doc.status, 200);
      assert.equal(
        doc.headers.get('x-content-sha256'),
        pick(opened.body, 'documents.0.contentSha256'),
      );
      const wrongHash = await call(null, 'POST', `/sign/api/${x.customerToken}/signature`, {
        package_sha256: 'e'.repeat(64),
        intent_statement: INTENT_STATEMENT,
      });
      assert.equal(wrongHash.status, 409);
      assert.equal(pick(wrongHash.body, 'error.code'), 'package_hash_mismatch');
      const signed = await call(null, 'POST', `/sign/api/${x.customerToken}/signature`, {
        package_sha256: x.packageSha256,
        intent_statement: INTENT_STATEMENT,
      });
      assert.equal(signed.status, 200, signed.text);
      assert.equal(pick(signed.body, 'completed'), false);
      assert.equal(pick(signed.body, 'package.state'), 'partially_signed');

      // THE DEALER SIGNS THROUGH THE STAFF LANE — the named manager only.
      const terms = await call(
        x.w.tokens.manager,
        'GET',
        `/api/jacket/ceremonies/${x.ceremonyId}/signing-terms`,
      );
      assert.equal(terms.status, 200);
      const bySeller = await call(
        x.w.tokens.seller,
        'POST',
        `/api/jacket/ceremonies/${x.ceremonyId}/dealer-signature`,
        {
          package_sha256: x.packageSha256,
          intent_statement: pick(terms.body, 'intent_statement'),
          consent_text_version: pick(terms.body, 'consent_text_version'),
        },
      );
      assert.equal(bySeller.status, 404, 'a salesperson cannot sign for the dealership');
      const byManager = await call(
        x.w.tokens.manager,
        'POST',
        `/api/jacket/ceremonies/${x.ceremonyId}/dealer-signature`,
        {
          package_sha256: x.packageSha256,
          intent_statement: pick(terms.body, 'intent_statement'),
          consent_text_version: pick(terms.body, 'consent_text_version'),
        },
      );
      assert.equal(byManager.status, 200, byManager.text);
      assert.equal(pick(byManager.body, 'completed'), true);
      const certificate = await fetch(base + `/api/jacket/ceremonies/${x.ceremonyId}/certificate`, {
        headers: { authorization: `Bearer ${x.w.tokens.seller}` },
      });
      assert.equal(certificate.status, 200);
      assert.equal(
        certificate.headers.get('x-content-sha256'),
        pick(byManager.body, 'ceremony.completionCertificateSha256'),
      );
      const done = await call(null, 'GET', `/sign/api/${x.customerToken}`);
      assert.equal(pick(done.body, 'nextStep'), 'done');
      assert.equal(pick(done.body, 'ceremony.state'), 'completed');
    });

    test('the provider’s lane is a signature over the raw body: unsigned is refused before it is read, a replay converges', async () => {
      const x = await walkToSent();
      const envelope = await query(
        `SELECT provider_envelope_ref FROM signing_ceremonies WHERE tenant_id = $1 AND ceremony_id = $2`,
        [x.w.tenantId, x.ceremonyId],
      );
      const body = JSON.stringify({
        event_id: 'evt_http_1',
        event_type: 'envelope.viewed',
        envelope_ref: (envelope.rows[0] as { provider_envelope_ref: string }).provider_envelope_ref,
        envelope_status: 'sent',
        occurred_at: new Date().toISOString(),
        metadata: { tenant_id: x.w.tenantId, ceremony_id: x.ceremonyId },
      });
      const post = (payload: string, headers: Record<string, string>) =>
        fetch(base + '/api/jacket/provider/esign/callback', {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: payload,
        });

      const unsigned = await post(body, {});
      assert.equal(unsigned.status, 401);
      assert.equal(
        ((await unsigned.json()) as { error: { code: string } }).error.code,
        'provider_signature_invalid',
      );
      const forged = await post(body, {
        'x-esign-signature': signProviderBody(
          ['not', 'the', 'key', '0123456789abcdef0123456789'].join('-'),
          body,
        ),
      });
      assert.equal(forged.status, 401);
      const tampered = await post(body.replace('envelope.viewed', 'envelope.completed'), {
        'x-esign-signature': signProviderBody(WEBHOOK_SECRET, body),
      });
      assert.equal(tampered.status, 401, 'one changed byte, no signature');
      // A staff bearer token is not the provider's credential either.
      const staff = await fetch(base + '/api/jacket/provider/esign/callback', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${x.w.tokens.manager}`,
        },
        body,
      });
      assert.equal(staff.status, 401);

      const signed = await post(body, {
        'x-esign-signature': signProviderBody(WEBHOOK_SECRET, body),
      });
      assert.equal(signed.status, 200, await signed.text());
      const replay = await post(body, {
        'x-esign-signature': signProviderBody(WEBHOOK_SECRET, body),
      });
      assert.equal(replay.status, 200);
      assert.equal(((await replay.json()) as { replayed: boolean }).replayed, true);
      const rows = await query(
        `SELECT COUNT(*)::int AS n FROM ceremony_events WHERE tenant_id = $1 AND provider_event_ref = 'evt_http_1'`,
        [x.w.tenantId],
      );
      assert.equal(Number((rows.rows[0] as { n: number }).n), 1);
      const stranger = JSON.stringify({
        ...JSON.parse(body),
        event_id: 'evt_http_2',
        metadata: { tenant_id: x.w.tenantId, ceremony_id: randomUUID() },
      });
      const unknown = await post(stranger, {
        'x-esign-signature': signProviderBody(WEBHOOK_SECRET, stranger),
      });
      assert.equal(unknown.status, 404);
    });

    test('the event ledger, the outbox and the audit trail carry ids and digests — never a name, an address or a link', async () => {
      const x = await walkToSent();
      await call(null, 'GET', `/sign/api/${x.customerToken}`);
      await call(null, 'POST', `/sign/api/${x.customerToken}/consent`, {
        consent_text_version: CONSENT_TEXT_VERSION,
      });
      await call(null, 'POST', `/sign/api/${x.customerToken}/signature`, {
        package_sha256: x.packageSha256,
        intent_statement: INTENT_STATEMENT,
      });
      const pii = /Dana|Ortiz|example\.com|\/sign\/#\//;
      const events = await query(
        `SELECT event_type, payload::text AS payload FROM ceremony_events WHERE tenant_id = $1`,
        [x.w.tenantId],
      );
      assert.ok(events.rows.length >= 5);
      for (const r of events.rows)
        assert.doesNotMatch(
          String((r as { payload: string }).payload),
          pii,
          String((r as { event_type: string }).event_type),
        );
      const outbox = await query(
        `SELECT event_type, payload::text AS payload FROM admin_outbox WHERE tenant_id = $1 AND event_type LIKE 'jacket.%'`,
        [x.w.tenantId],
      );
      assert.ok(outbox.rows.length >= 3, 'opened, assembled, sent');
      for (const r of outbox.rows)
        assert.doesNotMatch(String((r as { payload: string }).payload), pii);
      const audit = await query(
        `SELECT event_type, details::text AS details FROM audit_events WHERE tenant_id = $1 AND event_type LIKE 'jacket.%'`,
        [x.w.tenantId],
      );
      assert.ok(audit.rows.length >= 4);
      for (const r of audit.rows)
        assert.doesNotMatch(String((r as { details: string }).details), pii);
      // The raw token exists nowhere in the database.
      const raw = x.customerToken.split('.')[1]!;
      for (const table of ['ceremony_signers', 'ceremony_events', 'admin_outbox', 'audit_events']) {
        const leaked = await query(
          `SELECT COUNT(*)::int AS n FROM ${table} t WHERE t::text LIKE '%' || $1 || '%'`,
          [raw],
        );
        assert.equal(Number((leaked.rows[0] as { n: number }).n), 0, `${table} holds no raw token`);
      }
    });

    test('this phase still cannot create a sale, a funded deal or a delivery, because there is nowhere to put one', async () => {
      const tables = await query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('sales', 'deals', 'deliveries', 'sold_inventory', 'fundings', 'payments', 'credit_applications', 'title_registrations')`,
        [],
      );
      assert.deepEqual(tables.rows, [], 'the exclusion list is structural, not a convention');
      const constraint = await query(
        `SELECT conname FROM pg_constraint WHERE conname = 'ck_attribution_pre_sale_revenue'`,
        [],
      );
      assert.equal(constraint.rows.length, 1, 'the pre-sale revenue boundary is still in force');
    });

    test('an unauthenticated caller reaches nothing on the staff surface', async () => {
      const w = await seedJacketWorld(env);
      for (const [method, path] of [
        ['GET', '/api/jacket/board'],
        ['GET', '/api/jacket/find/approved'],
        ['POST', '/api/jacket/jackets'],
        ['GET', `/api/jacket/jackets/${randomUUID()}`],
        ['POST', `/api/jacket/jackets/${randomUUID()}/packages`],
        ['POST', `/api/jacket/packages/${randomUUID()}/send`],
        ['GET', '/api/jacket/configuration'],
        ['GET', `/api/jacket/jackets/${randomUUID()}/export`],
      ] as const) {
        const res = await call(
          null,
          method,
          path,
          method === 'POST' ? { desking_case_id: w.caseId } : undefined,
        );
        assert.equal(res.status, 401, `${method} ${path}: ${res.text}`);
      }
    });
  },
);
