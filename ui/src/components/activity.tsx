import { Link } from 'react-router-dom';
import type { AuditRecord } from '../lib/api.js';
import { ago, dateTime, humanize, shortId } from '../lib/format.js';
import type { Directory } from '../lib/org.js';
import { Icon, activityIcon, type IconName } from './icons.js';

/** Who did it, as an icon: you, an agent, or Conductor itself. */
export const actorIcon = (kind: string): IconName => (kind === 'human' ? 'user' : kind === 'system' ? 'server' : 'agent');

/** The round icon badge for one audit record (what kind of thing happened). */
export function ActionBadge({ action }: { action: string }) {
  return <span className={`action-badge ab-${action.split('.')[0]}`}><Icon name={activityIcon(action)} size={13} /></span>;
}

export function actorName(rec: AuditRecord, dir: Directory): string {
  if (rec.actor.kind === 'human') return 'You';
  if (rec.actor.kind === 'system') return 'Conductor';
  return dir.agentName(rec.actor.id, 'An agent');
}

/** Where an audit record points, when the console has a page for it. */
export function activityLink(rec: AuditRecord, base: string, dir: Directory): string | null {
  if (rec.runId) return `${base}/runs/${rec.runId}`;
  if (rec.issueId) return `${base}/issues/${rec.issueId}`;
  if (rec.entityKind === 'issue' && rec.entityId) return `${base}/issues/${rec.entityId}`;
  if (rec.entityKind === 'run' && rec.entityId) return `${base}/runs/${rec.entityId}`;
  if (rec.entityKind === 'agent' && rec.entityId) {
    const a = dir.agent(rec.entityId);
    return a ? `${base}/agents/${a.slug}` : null;
  }
  return null;
}

export function activitySubject(rec: AuditRecord, dir: Directory): string {
  const data = rec.data ?? {};
  const named = [data.title, data.name, data.tool, data.key].find((v): v is string => typeof v === 'string' && v.length > 0);
  if (rec.entityKind === 'agent' && rec.entityId) return dir.agentName(rec.entityId);
  if (named) return named;
  if (rec.entityKind && rec.entityId) return `${humanize(rec.entityKind).toLowerCase()} ${shortId(rec.entityId)}`;
  return '';
}

export function ActivityList({ items, base, dir }: { items: AuditRecord[]; base: string; dir: Directory }) {
  return (
    <ol className="feed">
      {items.map((rec) => {
        const to = activityLink(rec, base, dir);
        const subject = activitySubject(rec, dir);
        return (
          <li key={rec.id}>
            <ActionBadge action={rec.action} />
            <span className="feed-actor">{actorName(rec, dir)}</span>
            <span className="feed-what">
              {humanize(rec.action).toLowerCase()}
              {subject ? <> {to ? <Link to={to}>{subject}</Link> : <span className="dim">{subject}</span>}</> : null}
            </span>
            <time className="feed-time" dateTime={new Date(rec.ts).toISOString()} title={dateTime(rec.ts)}>{ago(rec.ts)}</time>
          </li>
        );
      })}
    </ol>
  );
}

const VERBS: Record<string, string> = {
  'issue.created': 'created', 'issue.updated': 'updated', 'issue.assigned': 'assigned', 'issue.delegated': 'split up', 'issue.escalated': 'escalated',
  'issue.reviewed': 'reviewed', 'issue.handed_off': 'handed off', 'issue.checked_out': 'picked up', 'issue.released': 'put down',
  'comment.added': 'commented on', 'run.started': 'started working on', 'run.finished': 'finished a run on', 'run.cancelled': 'cancelled a run on',
  'approval.requested': 'asked for approval to', 'approval.decided': 'decided on', 'approval.expired': 'let expire',
  'agent.hired': 'hired', 'agent.paused': 'paused', 'agent.resumed': 'resumed', 'agent.terminated': 'let go of', 'agent.updated': 'updated',
  'skill.changed': 'updated the skill', 'skill.activated': 'activated the skill', 'skill.created': 'wrote the skill', 'memory.written': 'remembered',
  'goal.created': 'set the goal', 'goal.updated': 'updated the goal', 'connector.installed': 'installed', 'config.changed': 'changed settings for',
  'budget.hard_stop': 'stopped spending at the cap for', 'budget.soft_alert': 'warned about spend for', 'tool.called': 'used',
};

/** One audit record as a short sentence's verb: "moved to Blocked", "approved", "used". Unknown actions read as their words. */
export function activityVerb(rec: AuditRecord): string {
  const data = rec.data ?? {};
  if (rec.action === 'issue.updated' && typeof data.status === 'string') return `moved to ${humanize(data.status)}`;
  if (rec.action === 'approval.decided' && typeof data.status === 'string') return data.status === 'approved' ? 'approved' : data.status === 'denied' ? 'denied' : 'decided on';
  return VERBS[rec.action] ?? humanize(rec.action.split('.').slice(1).join(' ') || rec.action).toLowerCase();
}

/** "Today", "Yesterday", or the date: headings for a log read top to bottom. */
export function dayLabel(ts: number, now = new Date()): string {
  const d = new Date(ts);
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((start(now) - start(d)) / 86_400_000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}
