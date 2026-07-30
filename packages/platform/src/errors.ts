/**
 * @dealer/platform — common error primitives.
 *
 * These classes are the application-wide error vocabulary (stable `code`, HTTP status,
 * optional i18n message and details). The Express renderer that turns them into the
 * public envelope lives with the API transport (apps/api); domain and application code
 * throw these without knowing anything about HTTP framing.
 */

export interface I18nMessage {
  en: string;
  es: string;
}

/**
 * Base class for every error this API deliberately returns. `code` is the stable,
 * machine-readable discriminator clients branch on; `message` is for humans and may
 * change. `messageI18n` is populated for errors that surface directly to a bilingual
 * customer-facing surface (service advisors run English/Spanish side by side).
 */
export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: Record<string, unknown>;
  public readonly messageI18n?: I18nMessage;

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { details?: Record<string, unknown>; messageI18n?: I18nMessage } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = options.details;
    this.messageI18n = options.messageI18n;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 400 — the request itself is malformed or internally inconsistent. */
export class ValidationError extends AppError {
  constructor(
    message: string,
    options: { code?: string; details?: Record<string, unknown>; messageI18n?: I18nMessage } = {},
  ) {
    super(400, options.code ?? 'validation_error', message, options);
  }
}

/** 401 — no usable credential was presented. */
export class UnauthorizedError extends AppError {
  constructor(
    message = 'Authentication required',
    options: { code?: string; details?: Record<string, unknown> } = {},
  ) {
    super(401, options.code ?? 'unauthorized', message, options);
  }
}

/** 403 — the credential is valid but not permitted to do this. */
export class ForbiddenError extends AppError {
  constructor(
    message = 'Not permitted',
    options: { code?: string; details?: Record<string, unknown>; messageI18n?: I18nMessage } = {},
  ) {
    super(403, options.code ?? 'forbidden', message, options);
  }
}

/**
 * 404 — no such row *within the caller's tenant*. Cross-tenant reads are deliberately
 * reported as "not found" rather than "forbidden" so the API does not confirm the
 * existence of another tenant's records.
 */
export class NotFoundError extends AppError {
  constructor(
    message = 'Not found',
    options: { code?: string; details?: Record<string, unknown> } = {},
  ) {
    super(404, options.code ?? 'not_found', message, options);
  }
}

/** 409 — the row exists but is not in a state that permits this operation. */
export class ConflictError extends AppError {
  constructor(
    message: string,
    options: { code?: string; details?: Record<string, unknown>; messageI18n?: I18nMessage } = {},
  ) {
    super(409, options.code ?? 'conflict', message, options);
  }
}

/** 422 — well-formed request that violates a domain rule (e.g. an illegal state change). */
export class UnprocessableError extends AppError {
  constructor(
    message: string,
    options: { code?: string; details?: Record<string, unknown>; messageI18n?: I18nMessage } = {},
  ) {
    super(422, options.code ?? 'unprocessable', message, options);
  }
}
