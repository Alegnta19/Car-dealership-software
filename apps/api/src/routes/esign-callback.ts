/**
 * FBL-140 — THE PROVIDER'S LANE (/api/jacket/provider/esign/callback).
 *
 * Mounted BEFORE the JSON body parser, because the signature is over the raw
 * bytes and a re-serialised body is not the body that was signed. No
 * `authenticate` here on purpose: the provider holds no session and no user
 * link, and its one credential is the HMAC under the configured secret.
 *
 * THE ORDER OF REFUSALS IS THE ORDER OF TRUST. Unconfigured secret → 503 and
 * nothing read. Bad or missing signature → 401 and nothing read — not the
 * tenant, not the ceremony, nothing, because a body that failed verification
 * has no trustworthy field in it. Only a verified body is parsed, and only a
 * parsed body reaches the tenant-scoped, replay-safe write.
 *
 * WHAT A REPLAY GETS. 200 with `replayed: true`. A provider that redelivers
 * after a timeout must see success, or it redelivers for ever; it must also
 * leave exactly one row, which the unique key guarantees.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import {
  parseProviderCallback,
  PROVIDER_SIGNATURE_HEADER,
  recordProviderCallback,
  verifyProviderSignature,
} from '@dealer/jacket';
import {
  NotFoundError,
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
  getConfig,
  logger,
} from '@dealer/platform';

const router = Router();

router.post(
  '/esign/callback',
  express.raw({ type: '*/*', limit: '256kb' }),
  (req: Request, res: Response, next: NextFunction): void => {
    (async () => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const header = req.header(PROVIDER_SIGNATURE_HEADER);
      const verdict = verifyProviderSignature(raw, header, getConfig().esignWebhookSecret);
      if (verdict === 'unconfigured') {
        throw new ServiceUnavailableError(
          'provider callbacks are not configured on this deployment',
          {
            code: 'provider_callbacks_unconfigured',
          },
        );
      }
      if (verdict === 'invalid') {
        // IDS ONLY — and there are none to log yet, because nothing is trusted.
        logger.warn(
          { bytes: raw.byteLength },
          'e-sign provider callback refused: signature invalid',
        );
        throw new UnauthorizedError('provider signature invalid', {
          code: 'provider_signature_invalid',
        });
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString('utf8'));
      } catch {
        throw new ValidationError('callback body is not valid JSON', { code: 'malformed_json' });
      }
      const callback = parseProviderCallback(parsed);
      if ('error' in callback) {
        throw new ValidationError(callback.error, { code: 'provider_callback_invalid' });
      }
      const recorded = await recordProviderCallback(callback);
      if (recorded.outcome === 'unknown_envelope') throw new NotFoundError('Resource not found');
      if (recorded.outcome === 'replayed') {
        res
          .status(200)
          .json({ recorded: false, replayed: true, ceremony_state: recorded.ceremony.state });
        return;
      }
      res.status(200).json({
        recorded: true,
        replayed: false,
        event_id: recorded.eventId,
        reconciliation: recorded.reconciliation,
        ceremony_state: recorded.ceremony.state,
      });
    })().catch(next);
  },
);

export default router;
