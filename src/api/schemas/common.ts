import { z } from 'zod';

/** Shared zod building blocks for request bodies and query strings. */
export const idStr = z.string().trim().min(1).max(200);
export const nameStr = z.string().trim().min(1).max(200);
export const text = (max: number) => z.string().max(max);
export const usd = z.number().finite().nonnegative().nullable();
export const refList = z.array(z.string().trim().min(1).max(300)).max(1000);
export const jsonRecord = z.record(z.string(), z.unknown());
export const secretRef = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,200}$/, 'invalid secret ref')
  .refine((r) => !r.includes('..'), 'invalid secret ref');

/** Query-string helpers (values arrive as strings). */
export const intQ = (min: number, max: number) => z.coerce.number().int().min(min).max(max);
export const boolQ = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
export const csvQ = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((v) => v.split(',').map((x) => x.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1).max(50));

export const empty = z.strictObject({});
/** Bodies that are optional altogether (POST with no payload). */
export const optionalBody = <S extends z.ZodType>(schema: S) => z.preprocess((v) => v ?? {}, schema);

const bindingBase = z.strictObject({
  adapter: z.string().trim().min(1).max(100),
  model: z.string().trim().min(1).max(200).optional(),
  config: jsonRecord.optional(),
  authRef: secretRef.optional(),
});
/** Provider binding: credentials are referenced (`authRef`), never embedded. */
export const providerBinding = bindingBase.extend({ fallback: z.array(bindingBase).max(10).optional() });

export const toolPolicy = z.enum(['allowed', 'ask', 'off']);
export const scope = z.enum(['global', 'org', 'dept', 'agent']);
