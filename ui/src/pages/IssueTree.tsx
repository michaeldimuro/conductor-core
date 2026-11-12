import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Button, Empty, ErrorNote, Loading } from '../components/ui.js';
import { Icon, StatusIcon } from '../components/icons.js';
import { api } from '../lib/api.js';
import type { Issue, ListIssuesQuery } from '../lib/api.js';
import { ago, blockedText } from '../lib/format.js';
import { buildIssueTree, isClosed, type IssueNode } from '../lib/issue-tree.js';
import { STATUS_LABEL, k, useOrg, type Directory } from '../lib/org.js';
import { useQuery } from '../lib/query.js';

type Filter = Pick<ListIssuesQuery, 'assigneeAgentId' | 'goalId' | 'label' | 'search'>;

const API_MAX = 500;
/** The tree needs every issue to place sub-issues under their parents; past this it says it is partial. */
const TREE_MAX = 5000;

interface AllIssues {
  items: Issue[];
  more: boolean;
}

async function fetchAll(orgId: string, filter: Filter): Promise<AllIssues> {
  const items: Issue[] = [];
  let offset: number | null = 0;
  while (offset !== null && items.length < TREE_MAX) {
    const page = await api.listIssues(orgId, { ...filter, limit: API_MAX, offset });
    items.push(...page.items);
    offset = page.nextOffset;
  }
  return { items, more: offset !== null };
}

const storeKey = (orgId: string) => `conductor.issues.tree.open.${orgId}`;
function readOpen(orgId: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(storeKey(orgId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

/** One quiet line per issue: the status glyph carries the colour, everything else is plain or muted text. */
function Row({ node, depth, dir, open, toggle }: { node: IssueNode<Issue>; depth: number; dir: Directory; open: Set<string>; toggle: (id: string) => void }) {
  const { base } = useOrg();
  const i = node.issue;
  const r = node.rollup;
  const expandable = node.children.length > 0;
  const expanded = expandable && open.has(i.id);
  const reason = i.status === 'blocked' && i.blockedReason ? blockedText(i.blockedReason) : '';
  const counted = r.total - r.cancelled;
  const tip = [`${STATUS_LABEL[i.status]}: ${i.title}`, reason].filter(Boolean).join('\n\n');
  return (
    <li className={`itree-item${isClosed(i.status) ? ' itree-closed' : ''}`} role="treeitem" aria-expanded={expandable ? expanded : undefined} aria-level={depth + 1}>
      <div className="itree-row" title={tip}>
        {expandable ? (
          <button type="button" className="itree-caret" aria-label={`${expanded ? 'Collapse' : 'Expand'} #${i.number}`} onClick={() => toggle(i.id)}>
            <Icon name="right" size={14} className={expanded ? 'itree-caret-open' : undefined} />
          </button>
        ) : <span className="itree-caret" aria-hidden="true" />}
        <span className="itree-status" aria-label={STATUS_LABEL[i.status]}><StatusIcon status={i.status} /></span>
        <span className="itree-main">
          <Link className="itree-title" to={`${base}/issues/${i.number}`}>{i.title}</Link>
          {counted > 0 ? <span className="itree-note">{r.done}/{counted} done</span> : null}
          {node.waitingOn.length ? (
            <span className="itree-note">
              waiting on {node.waitingOn.map((w, n) => <span key={w.id}>{n ? ', ' : ''}<Link to={`${base}/issues/${w.number}`} title={`${STATUS_LABEL[w.status]}: ${w.title}`}>#{w.number}</Link></span>)}
            </span>
          ) : null}
          {i.checkoutLock ? <span className="itree-note itree-live">working</span> : null}
        </span>
        <span className="itree-who truncate">{i.assigneeAgentId ? dir.agentName(i.assigneeAgentId) : ''}</span>
        <span className="itree-num">#{i.number}</span>
        <span className="itree-when">{ago(i.updatedAt)}</span>
      </div>
      {expanded ? (
        <ul role="group" className="itree-kids">
          {node.children.map((c) => <Row key={c.issue.id} node={c} depth={depth + 1} dir={dir} open={open} toggle={toggle} />)}
        </ul>
      ) : null}
    </li>
  );
}

/** Issues as parent → sub-issue trees, each top-level item rolling up how far along its sub-issues are and what they are waiting on. */
export function IssueTree({ filter, filterKey, dir }: { filter: Filter; filterKey: string; dir: Directory }) {
  const { org } = useOrg();
  const filtered = Object.values(filter).some(Boolean);
  const [showClosed, setShowClosed] = useState(false);
  const [open, setOpen] = useState<Set<string>>(() => readOpen(org.id));

  // The whole org gives the structure; a filtered fetch says which nodes matched, so matches keep their parents.
  const all = useQuery(k(org.id, 'issues', 'tree', 'all'), () => fetchAll(org.id, {}), { events: ['issue.'], orgId: org.id });
  const hits = useQuery(filtered ? k(org.id, 'issues', 'tree', 'hits', filterKey) : null, () => fetchAll(org.id, filter), { events: ['issue.'], orgId: org.id });

  const forest = useMemo(() => {
    if (!all.data || (filtered && !hits.data)) return null;
    const ids = filtered ? new Set(hits.data!.items.map((i) => i.id)) : null;
    const trees = buildIssueTree(all.data.items, ids ? (i) => ids.has(i.id) : undefined);
    // A finished tree drops out of the default view; open trees keep their finished sub-issues for context.
    return showClosed ? trees : trees.filter((t) => !isClosed(t.issue.status));
  }, [all.data, hits.data, filtered, showClosed]);

  const persist = (next: Set<string>) => {
    try {
      window.localStorage.setItem(storeKey(org.id), JSON.stringify([...next]));
    } catch {
      // Private mode or blocked storage: folding still works for this session.
    }
    return next;
  };
  const toggle = (id: string) => setOpen((o) => {
    const next = new Set(o);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return persist(next);
  });
  const setAll = (expand: boolean) => {
    if (!expand) return setOpen(persist(new Set()));
    const ids: string[] = [];
    const walk = (n: IssueNode<Issue>) => {
      if (n.children.length) ids.push(n.issue.id);
      n.children.forEach(walk);
    };
    forest?.forEach(walk);
    setOpen(persist(new Set(ids)));
  };

  const error = all.error ?? hits.error;
  if (!forest) return error ? <ErrorNote error={error} retry={() => { all.reload(); hits.reload(); }} /> : <Loading lines={6} />;

  const summary = forest.reduce((s, t) => ({ trees: s.trees + 1, review: s.review + t.rollup.inReview + (t.issue.status === 'in_review' ? 1 : 0), blocked: s.blocked + t.rollup.blocked + (t.issue.status === 'blocked' ? 1 : 0) }), { trees: 0, review: 0, blocked: 0 });
  return (
    <section className="itree-wrap" aria-label="Issue tree">
      <div className="itree-bar-top">
        <span className="muted">
          {summary.trees} top-level {summary.trees === 1 ? 'issue' : 'issues'}
          {summary.review ? ` · ${summary.review} in review` : ''}
          {summary.blocked ? ` · ${summary.blocked} blocked` : ''}
          {all.data?.more ? ` · showing the first ${TREE_MAX} issues` : ''}
        </span>
        <span className="row row-tight">
          <label className="itree-toggle"><input type="checkbox" checked={showClosed} onChange={(e) => setShowClosed(e.target.checked)} />Show finished</label>
          <Button small variant="quiet" onClick={() => setAll(true)}>Expand all</Button>
          <Button small variant="quiet" onClick={() => setAll(false)}>Collapse all</Button>
        </span>
      </div>
      {forest.length === 0 ? (
        <Empty title={filtered ? 'No issues match these filters' : 'No open issues'}>{showClosed || filtered ? null : 'Tick "Show finished" to see done and cancelled work.'}</Empty>
      ) : (
        <ul className="itree" role="tree" aria-label="Issues by parent">
          {forest.map((t) => <Row key={t.issue.id} node={t} depth={0} dir={dir} open={open} toggle={toggle} />)}
        </ul>
      )}
    </section>
  );
}
