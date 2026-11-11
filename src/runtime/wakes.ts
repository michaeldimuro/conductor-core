import type { RunTrigger } from '../db/schema/index.js';

/** One reason an agent was woken. Several can be queued on the agent's single pending wake job. */
export interface Wake {
  trigger: RunTrigger;
  /** Pin the run to this issue. */
  issueId?: string | null;
  triggerNote?: string;
  /** Free-form task (webhook payload, manual prompt). */
  prompt?: string;
  /** Provider session to resume; only valid together with the `issueId` it belonged to. */
  resumeSessionId?: string;
  /** Planning wake: decompose this goal into issues. */
  goalId?: string | null;
}

export type JobPayload = Record<string, unknown>;

/** Upper bound on wakes queued for one agent; beyond it the oldest plain nudges are dropped first. */
export const MAX_QUEUED_WAKES = 100;

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

function toWake(raw: unknown): Wake | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const wake: Wake = { trigger: (str(r.trigger) as RunTrigger | undefined) ?? 'manual' };
  const issueId = str(r.issueId);
  const triggerNote = str(r.triggerNote);
  const prompt = str(r.prompt);
  const resumeSessionId = str(r.resumeSessionId);
  const goalId = str(r.goalId);
  if (issueId) wake.issueId = issueId;
  if (triggerNote) wake.triggerNote = triggerNote;
  if (prompt) wake.prompt = prompt;
  if (resumeSessionId) wake.resumeSessionId = resumeSessionId;
  if (goalId) wake.goalId = goalId;
  return wake;
}

/** The wakes a job carries. Accepts the queued form (`{ wakes: [...] }`) and a single flat wake. */
export function wakesOf(payload: JobPayload): Wake[] {
  if (Array.isArray(payload.wakes)) return payload.wakes.map(toWake).filter((w): w is Wake => w !== null);
  const single = toWake(payload);
  return single ? [single] : [];
}

export const deferralsOf = (payload: JobPayload): number => (typeof payload.deferrals === 'number' && payload.deferrals > 0 ? Math.floor(payload.deferrals) : 0);

/** A nudge only says "look at your inbox" (optionally "start with this issue"); it carries nothing that could be lost by folding. */
export const isNudge = (w: Wake): boolean => !w.prompt && !w.goalId && !w.resumeSessionId;

const key = (w: Wake): string => JSON.stringify([w.trigger, w.issueId ?? null, w.triggerNote ?? null, w.prompt ?? null, w.resumeSessionId ?? null, w.goalId ?? null]);

function compact(wakes: Wake[]): Wake[] {
  const seen = new Set<string>();
  let out = wakes.filter((w) => {
    const k = key(w);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (out.length > MAX_QUEUED_WAKES) {
    // Dropping a nudge loses nothing while another wake remains: the next run reads the whole inbox.
    let excess = out.length - MAX_QUEUED_WAKES;
    out = out.filter((w) => !(excess > 0 && isNudge(w) && excess--));
  }
  return out.slice(-MAX_QUEUED_WAKES);
}

export function wakePayload(wakes: Wake[], deferrals = 0): JobPayload {
  const list = compact(wakes);
  return { trigger: list[0]?.trigger ?? 'manual', wakes: list, ...(deferrals > 0 ? { deferrals } : {}) };
}

/**
 * Merge a second wake into the agent's pending wake job instead of dropping
 * it. `front` puts the incoming wakes first (re-queueing what a run left over).
 */
export function mergeWakePayloads(existing: JobPayload, incoming: JobPayload, opts: { front?: boolean } = {}): JobPayload {
  const a = wakesOf(existing);
  const b = wakesOf(incoming);
  return wakePayload(opts.front ? [...b, ...a] : [...a, ...b], Math.max(deferralsOf(existing), deferralsOf(incoming)));
}

/**
 * Pick what ONE run handles. A wake carrying a prompt, a goal or a session to
 * resume runs alone. Plain nudges fold into one run (their notes are joined,
 * the first pinned issue wins); everything else stays queued, in order.
 */
export function foldWakes(wakes: Wake[]): { request: Wake | null; rest: Wake[] } {
  const [head, ...others] = wakes;
  if (!head) return { request: null, rest: [] };
  if (!isNudge(head)) return { request: head, rest: others };

  const request: Wake = { ...head };
  const notes = new Set<string>(head.triggerNote ? [head.triggerNote] : []);
  const rest: Wake[] = [];
  for (const w of others) {
    const conflicts = !!w.issueId && !!request.issueId && w.issueId !== request.issueId;
    if (!isNudge(w) || conflicts) {
      rest.push(w);
      continue;
    }
    if (w.issueId && !request.issueId) {
      request.issueId = w.issueId;
      request.trigger = w.trigger;
    }
    if (w.triggerNote) notes.add(w.triggerNote);
  }
  if (notes.size > 0) request.triggerNote = [...notes].join(' ');
  return { request, rest };
}

/** Backoff for a wake skipped for a temporary cause: 1, 2, 4… minutes, capped. */
export function deferBackoffMs(deferrals: number, capMs: number): number {
  return Math.min(60_000 * 2 ** Math.min(deferrals, 10), capMs);
}
