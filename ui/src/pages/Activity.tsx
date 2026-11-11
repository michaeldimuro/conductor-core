import { useState } from 'react';
import { Link } from 'react-router-dom';
import { activityLink, activitySubject, actorName } from '../components/activity.js';
import { Button, Empty, JsonView, Load, PageHead, Panel } from '../components/ui.js';
import { api } from '../lib/api.js';
import { dateTime, fromDateInput, humanize } from '../lib/format.js';
import { k, useDirectory, useOrg } from '../lib/org.js';
import { useQuery } from '../lib/query.js';

const ENTITY_KINDS = ['issue', 'agent', 'dept', 'org', 'goal', 'run', 'approval', 'skill', 'memory', 'connector', 'secret', 'setting', 'webhook', 'gateway'] as const;
const PAGE = 200;

export function Activity() {
  const { org, base } = useOrg();
  const dir = useDirectory(org.id);
  const [action, setAction] = useState('');
  const [applied, setApplied] = useState('');
  const [entityKind, setEntityKind] = useState('');
  const [since, setSince] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const sinceTs = since ? fromDateInput(since)! - 12 * 3_600_000 : undefined;
  const log = useQuery(k(org.id, 'activity', 'log', applied, entityKind, since, limit),
    () => api.activity(org.id, { action: applied || undefined, entityKind: entityKind || undefined, since: sinceTs, limit }),
    { events: applied || entityKind ? [] : ['issue.', 'run.started', 'run.finished', 'approval.', 'agent.', 'goal.', 'skill.', 'memory.', 'comment.', 'org.'], orgId: org.id });
  return (
    <div className="page">
      <PageHead title="Activity" sub="The append-only audit log: every state change, tool call and decision, with who did it." />
      <form className="toolbar" role="search" onSubmit={(e) => { e.preventDefault(); setApplied(action.trim()); setLimit(PAGE); }}>
        <input className="toolbar-search mono" data-search aria-label="Filter by exact action" placeholder="Exact action, e.g. tool.called" value={action} onChange={(e) => { setAction(e.target.value); if (!e.target.value) setApplied(''); }} autoCapitalize="none" spellCheck={false} />
        <Button type="submit">Filter</Button>
        <select aria-label="Filter by subject" value={entityKind} onChange={(e) => setEntityKind(e.target.value)}><option value="">Any subject</option>{ENTITY_KINDS.map((x) => <option key={x} value={x}>{humanize(x)}</option>)}</select>
        <label className="row nowrap">Since <input type="date" aria-label="Since date" value={since} onChange={(e) => setSince(e.target.value)} style={{ width: 'auto' }} /></label>
      </form>
      <Panel flush>
        <Load q={log} empty={<Empty title="No activity matches these filters" />}>
          {(items) => (
            <>
              <ol className="audit">
                {items.map((rec) => {
                  const to = activityLink(rec, base, dir);
                  const subject = activitySubject(rec, dir);
                  return (
                    <li key={rec.id}>
                      <details>
                        <summary>
                          <time className="muted nowrap">{dateTime(rec.ts)}</time>
                          <span className="audit-actor truncate">{actorName(rec, dir)}</span>
                          <code className="audit-action">{rec.action}</code>
                          <span className="grow truncate dim">{subject}</span>
                        </summary>
                        <div className="tl-detail stack">
                          {to ? <p><Link to={to}>Open {rec.runId ? 'the run' : 'it'}</Link></p> : null}
                          <JsonView value={{ actor: rec.actor, entityKind: rec.entityKind, entityId: rec.entityId, runId: rec.runId, issueId: rec.issueId, data: rec.data }} />
                        </div>
                      </details>
                    </li>
                  );
                })}
              </ol>
              {items.length >= limit && limit < 1000 ? <div className="panel-body"><Button small busy={log.fetching} onClick={() => setLimit((l) => Math.min(1000, l + PAGE))}>Show {PAGE} more</Button></div> : null}
            </>
          )}
        </Load>
      </Panel>
    </div>
  );
}
