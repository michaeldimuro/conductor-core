import type { OrgTemplate } from '../../contracts/org-work.js';
import { AUTONOMY } from '../../contracts/types.js';

export type TemplateAgent = OrgTemplate['departments'][number]['agents'][number];

/** Leads check in every 30 minutes; specialists hourly. */
export const LEAD_HEARTBEAT = '*/30 * * * *';
export const SPECIALIST_HEARTBEAT = '0 * * * *';

interface Persona {
  name: string;
  role: string;
  goal: string;
  backstory: string;
}

/** The top agent: Lead autonomy, reports to the Owner (no `reportsToRole`). */
export function chief(p: Persona): TemplateAgent {
  return { ...p, autonomyLevel: AUTONOMY.LEAD, heartbeatCron: LEAD_HEARTBEAT, isLead: true };
}

/** A department lead: Lead autonomy, 30-minute heartbeat, reports to `reportsToRole`. */
export function lead(p: Persona, reportsToRole: string): TemplateAgent {
  return { ...p, autonomyLevel: AUTONOMY.LEAD, heartbeatCron: LEAD_HEARTBEAT, isLead: true, reportsToRole };
}

/** A specialist: Supervised autonomy, hourly heartbeat, reports to its lead. */
export function specialist(p: Persona, reportsToRole: string): TemplateAgent {
  return { ...p, autonomyLevel: AUTONOMY.SUPERVISED, heartbeatCron: SPECIALIST_HEARTBEAT, reportsToRole };
}
