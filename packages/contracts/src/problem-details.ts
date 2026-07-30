/**
 * @dealer/contracts — the internal RFC 9457-compatible Problem Details model
 * (FBL-010 section G).
 *
 * This is the CANONICAL internal error representation. It is not yet the public wire
 * format: the /api/service endpoints keep their characterized
 * `{ success: false, error: { code, message, details? } }` envelope through a
 * compatibility renderer in apps/api, and public `application/problem+json` adoption
 * plus API versioning belong to FBL-040.
 */
export interface ProblemDetails {
  /** URI reference identifying the problem type. */
  readonly type: string;
  /** Short, human-readable summary of the problem type. */
  readonly title: string;
  /** HTTP status code. */
  readonly status: number;
  /** Human-readable explanation specific to this occurrence. */
  readonly detail?: string;
  /** URI reference identifying this specific occurrence (the request path). */
  readonly instance?: string;
  /** Stable application error code — the discriminator clients branch on. */
  readonly code: string;
  /** Request correlation: the id echoed to the caller in x-request-id. */
  readonly requestId?: string;
  /** Structured validation/domain details, where applicable. */
  readonly errors?: unknown;
}

/** The characterized public success envelope. */
export interface SuccessEnvelope<T = unknown> {
  readonly success: true;
  readonly data: T;
}

/** The characterized public error envelope (compatibility rendering of ProblemDetails). */
export interface ErrorEnvelope {
  readonly success: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly message_es?: string;
    readonly details?: unknown;
  };
}
