export type ErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'unauthorized'
  | 'conflict'
  | 'validation'
  | 'budget_exceeded'
  | 'paused'
  | 'approval_required'
  | 'policy_denied'
  | 'unavailable'
  | 'internal';

const HTTP_STATUS: Record<ErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  unauthorized: 401,
  conflict: 409,
  validation: 400,
  budget_exceeded: 402,
  paused: 423,
  approval_required: 202,
  policy_denied: 403,
  unavailable: 503,
  internal: 500,
};

/** The single error type crossing bounded-context boundaries. */
export class ConductorError extends Error {
  readonly code: ErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ConductorError';
    this.code = code;
    this.details = details;
  }

  get httpStatus(): number {
    return HTTP_STATUS[this.code];
  }
}

export const notFound = (what: string, id?: string) =>
  new ConductorError('not_found', id ? `${what} ${id} not found` : `${what} not found`);
export const forbidden = (msg: string, details?: Record<string, unknown>) =>
  new ConductorError('forbidden', msg, details);
export const conflict = (msg: string, details?: Record<string, unknown>) =>
  new ConductorError('conflict', msg, details);
export const invalid = (msg: string, details?: Record<string, unknown>) =>
  new ConductorError('validation', msg, details);

export function isConductorError(e: unknown): e is ConductorError {
  return e instanceof ConductorError;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
