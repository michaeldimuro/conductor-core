import { Link } from 'react-router-dom';
import type { AuditRecord } from '../lib/api.js';
import { ago, dateTime, humanize, shortId } from '../lib/format.js';
import type { Directory } from '../lib/org.js';

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
