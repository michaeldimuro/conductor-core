/**
 * What a blocked issue is waiting on, encoded in `blockedReason` so no schema
 * change is needed. Pure: shared by the agent tools, the runtime sweep, the
 * digest and the dashboard.
 *
 *   needs_owner: <ask>\n\n<detail>        the owner must do something (the ask is one plain sentence)
 *   waiting_on_agent:<slug>: <note>         another agent's step comes first
 *   waiting_until:<ISO instant>: <note>     nothing can happen before a date; it reopens on its own then
 *   waiting_approval:<id>,<id>: <note>      approvals the owner is deciding; it reopens once all are decided
 *   waiting_external: <note>                something outside the company (a reply, a first customer)
 *
 * The runtime also parks issues with its own reasons (`budget`, `repeated_failures`,
 * `escalated_to_owner`, `awaiting_approval`, `needs_human`, `waiting_on_children`).
 * Anything else is free text from before waits were structured.
 */
export type Wait =
  | { kind: 'owner'; ask: string; detail: string }
  | { kind: 'agent'; agent: string; note: string }
  | { kind: 'until'; until: number; note: string }
  | { kind: 'approval'; approvalIds: string[]; note: string }
  | { kind: 'external'; note: string }
  | { kind: 'system'; reason: SystemBlock; note: string }
  | { kind: 'legacy'; text: string };

export const SYSTEM_BLOCKS = ['budget', 'repeated_failures', 'escalated_to_owner', 'awaiting_approval', 'needs_human', 'waiting_on_children'] as const;
export type SystemBlock = (typeof SYSTEM_BLOCKS)[number];

const OWNER = /^needs_owner:\s*([\s\S]*)$/;
const AGENT = /^waiting_on_agent:@?([\w.-]+):\s*([\s\S]*)$/;
const UNTIL = /^waiting_until:(\d{4}-\d\d-\d\dT[\d:.]+Z):\s*([\s\S]*)$/;
const APPROVAL = /^waiting_approval:([\w,-]+):\s*([\s\S]*)$/;
const EXTERNAL = /^waiting_external:\s*([\s\S]*)$/;
const SYSTEM = /^([a-z_]+)(?::\s*([\s\S]*))?$/;

export function parseWait(reason: string | null | undefined): Wait {
  const text = (reason ?? '').trim();
  let m: RegExpExecArray | null;
  if ((m = OWNER.exec(text))) {
    const [ask = '', ...rest] = (m[1] ?? '').split(/\n\s*\n/);
    return { kind: 'owner', ask: ask.trim(), detail: rest.join('\n\n').trim() };
  }
  if ((m = AGENT.exec(text))) return { kind: 'agent', agent: m[1]!, note: m[2]!.trim() };
  if ((m = UNTIL.exec(text))) {
    const until = Date.parse(m[1]!);
    if (Number.isFinite(until)) return { kind: 'until', until, note: m[2]!.trim() };
  }
  if ((m = APPROVAL.exec(text))) return { kind: 'approval', approvalIds: m[1]!.split(',').filter(Boolean), note: m[2]!.trim() };
  if ((m = EXTERNAL.exec(text))) return { kind: 'external', note: m[1]!.trim() };
  if ((m = SYSTEM.exec(text)) && (SYSTEM_BLOCKS as readonly string[]).includes(m[1]!)) {
    return { kind: 'system', reason: m[1] as SystemBlock, note: (m[2] ?? '').trim() };
  }
  return { kind: 'legacy', text };
}

const NOTE_MAX = 1800;
const clip = (s: string, max = NOTE_MAX) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

export function formatWait(w: Exclude<Wait, { kind: 'system' } | { kind: 'legacy' }>): string {
  switch (w.kind) {
    case 'owner':
      return `needs_owner: ${clip(w.ask.replace(/\s+/g, ' ').trim(), 300)}${w.detail ? `\n\n${clip(w.detail)}` : ''}`;
    case 'agent':
      return `waiting_on_agent:${w.agent}: ${clip(w.note)}`;
    case 'until':
      return `waiting_until:${new Date(w.until).toISOString()}: ${clip(w.note)}`;
    case 'approval':
      return `waiting_approval:${w.approvalIds.join(',')}: ${clip(w.note)}`;
    case 'external':
      return `waiting_external: ${clip(w.note)}`;
  }
}

/** True when the wait itself is the owner's to clear (before checking dependencies and duplicate cards). */
export const waitIsOwners = (w: Wait): boolean =>
  w.kind === 'owner' || w.kind === 'legacy' || (w.kind === 'system' && w.reason !== 'waiting_on_children');
