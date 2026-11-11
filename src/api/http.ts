import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';
import type { Services } from '../daemon/container.js';
import type { Organization, Agent, Issue } from '../contracts/rows.js';
import { ConductorError, invalid, isConductorError, notFound } from '../shared/errors.js';
import type { ApiErrorBody } from './types.js';

/** Validate boundary input; zod failures become `validation` ConductorErrors (HTTP 400). */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const r = schema.safeParse(input ?? {});
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
  throw invalid(issues.map((i) => `${i.path || 'input'}: ${i.message}`).join('; '), { issues });
}

export const body = <S extends z.ZodType>(req: FastifyRequest, schema: S): z.infer<S> => parse(schema, req.body);
export const query = <S extends z.ZodType>(req: FastifyRequest, schema: S): z.infer<S> => parse(schema, req.query);

/** A path parameter, always a non-empty string. */
export function param(req: FastifyRequest, name: string): string {
  const v = (req.params as Record<string, unknown> | undefined)?.[name];
  if (typeof v !== 'string' || v.length === 0 || v.length > 1024) throw invalid(`missing path parameter ${name}`);
  return v;
}

/** Org by id or slug; unknown → 404. Every org-scoped route goes through this. */
export function resolveOrg(s: Services, idOrSlug: string): Organization {
  const bySlug = s.org.getOrgBySlug(idOrSlug);
  if (bySlug) return bySlug;
  try {
    return s.org.getOrg(idOrSlug);
  } catch (e) {
    if (isConductorError(e) && e.code === 'not_found') throw notFound('organization', idOrSlug);
    throw e;
  }
}

export const orgOf = (s: Services, req: FastifyRequest): Organization => resolveOrg(s, param(req, 'orgId'));

/** Agent by id or slug inside the org; an agent of another org is not found. */
export function resolveAgent(s: Services, orgId: string, idOrSlug: string): Agent {
  const agent = s.org.findAgent(orgId, idOrSlug);
  if (!agent || agent.orgId !== orgId) throw notFound('agent', idOrSlug);
  return agent;
}

/** Issue by id or per-org number. */
export function resolveIssue(s: Services, orgId: string, idOrNumber: string): Issue {
  const key = /^\d+$/.test(idOrNumber) ? Number(idOrNumber) : idOrNumber;
  const issue = s.work.findIssue(orgId, key);
  if (!issue || issue.orgId !== orgId) throw notFound('issue', idOrNumber);
  return issue;
}

/** Guard for rows fetched by a global id: anything from another org behaves as not found. */
export function assertOrg<T extends { orgId: string | null }>(row: T | null | undefined, orgId: string, what: string, id: string, opts: { allowGlobal?: boolean } = {}): T {
  if (!row || (row.orgId !== orgId && !(opts.allowGlobal && row.orgId === null))) throw notFound(what, id);
  return row;
}

export function errorBody(code: string, message: string, details?: Record<string, unknown>): ApiErrorBody {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

/** Map any thrown value to the API error envelope. Internal errors never leak their message. */
export function toErrorResponse(err: unknown): { status: number; body: ApiErrorBody; internal: boolean } {
  if (isConductorError(err)) {
    const code = err instanceof HttpError && err.apiCode ? err.apiCode : err.code;
    return { status: err.httpStatus, body: errorBody(code, err.message, err.details), internal: err.code === 'internal' };
  }
  const e = err as { statusCode?: unknown; code?: unknown; message?: unknown };
  const status = typeof e?.statusCode === 'number' ? e.statusCode : 500;
  if (status >= 400 && status < 500) {
    const code = status === 404 ? 'not_found' : status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 409 ? 'conflict' : status === 429 ? 'rate_limited' : 'validation';
    return { status, body: errorBody(code, typeof e.message === 'string' ? e.message : 'bad request'), internal: false };
  }
  return { status: 500, body: errorBody('internal', 'internal error'), internal: true };
}

export function sendError(reply: FastifyReply, err: unknown): FastifyReply {
  const r = toErrorResponse(err);
  return reply.code(r.status).send(r.body);
}

export class HttpError extends ConductorError {
  constructor(private readonly status: number, code: ConductorError['code'], message: string, readonly apiCode?: string) {
    super(code, message);
  }
  override get httpStatus(): number {
    return this.status;
  }
}

/** Fixed-window in-memory rate limiter (wall clock; nothing is persisted). */
export class RateLimiter {
  private readonly hits = new Map<string, { n: number; resetAt: number }>();
  constructor(private readonly limit: number, private readonly windowMs: number) {}

  /** True when the call is allowed. */
  take(key: string): boolean {
    const now = Date.now();
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= now) {
      if (this.hits.size > 10_000) this.prune(now);
      this.hits.set(key, { n: 1, resetAt: now + this.windowMs });
      return true;
    }
    cur.n += 1;
    return cur.n <= this.limit;
  }

  private prune(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}

export const tooMany = (what: string) => new HttpError(429, 'unavailable', `rate limit exceeded for ${what}`, 'rate_limited');
