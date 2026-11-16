import { monotonicFactory } from 'ulid';

/**
 * Monotonic: two ids minted in the same millisecond still sort in creation order, so `ORDER BY createdAt, id`
 * is a true creation order (chat history, timelines) instead of a coin flip on ties.
 */
const ulid = monotonicFactory();

/** Entity id prefixes. Every id is `<prefix>_<ulid>` so logs are self-describing. */
export const ID_PREFIX = {
  org: 'org',
  dept: 'dept',
  agent: 'agt',
  goal: 'goal',
  project: 'proj',
  issue: 'iss',
  comment: 'cmt',
  run: 'run',
  runEvent: 'rev',
  job: 'job',
  skill: 'skl',
  skillVersion: 'skv',
  evalCase: 'evc',
  connector: 'con',
  grant: 'grt',
  toolCall: 'tc',
  memory: 'mem',
  approval: 'apr',
  browserProfile: 'bp',
  browserSession: 'bs',
  ledger: 'led',
  activity: 'act',
  revision: 'rvn',
  token: 'tok',
  gateway: 'gw',
  webhook: 'wh',
  playbook: 'pb',
  scorecard: 'sc',
  loginSession: 'lgn',
  chatMessage: 'chm',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${ulid()}`;
}

/** URL/filesystem-safe slug. Never returns an empty string or a path-traversal segment. */
export function slugify(input: string): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return s.length > 0 ? s : 'unnamed';
}
