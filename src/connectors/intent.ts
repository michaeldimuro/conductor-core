import { classifyAction, nameWords, type ActionCategory } from './actions.js';

/**
 * What an *opaque executor* call actually does, read from its arguments.
 *
 * Shell tools (`run_command`, Composio's remote bash), HTTP proxies
 * (`COMPOSIO_PROXY_EXECUTE`), multi-action runners (`COMPOSIO_MULTI_EXECUTE_TOOL`),
 * code workbenches and the browser's `evaluate` hide everything behind one
 * name, so name-based classification has to assume the worst and every call
 * asks. Most of these calls are routine (`ls`, `git status`, a GitHub GET), so
 * asking on all of them makes the owner approve noise every few seconds. This
 * module looks at the call itself:
 *
 * - `read`: inspects and changes nothing (listing, reading, GET requests).
 * - `write`: an ordinary change (build, test, commit, create, POST) — runs on its own.
 * - `destructive`: deletes data, rewrites history, deploys to production,
 *   publishes a package, escalates privileges — asks the owner.
 *
 * `category` replaces the tool's own category for the default gates, so an
 * inner `GMAIL_SEND_EMAIL` still meets the first-send gate and a payment still
 * meets the payment gate. `egress` marks calls that ship data to a third party
 * in a way no recipient gate can see (curl uploads, POSTing fetches, raw
 * sockets): harmless normally, Ask-first once the run has read untrusted content.
 *
 * Returns null when the tool is not an opaque executor or its arguments cannot
 * be read; the caller then keeps its conservative name-based behaviour.
 */
export type IntentLevel = 'read' | 'write' | 'destructive';

export interface CallIntent {
  level: IntentLevel;
  category: ActionCategory;
  egress: boolean;
  /** Short reason shown to the approver when a call still asks. */
  why: string;
}

const LEVEL_ORDER: IntentLevel[] = ['read', 'write', 'destructive'];
const worse = (a: IntentLevel, b: IntentLevel): IntentLevel => (LEVEL_ORDER.indexOf(a) >= LEVEL_ORDER.indexOf(b) ? a : b);

/** Gate-relevant categories, most consequential first. */
const CATEGORY_ORDER: ActionCategory[] = ['payment', 'send', 'publish', 'destructive', 'exec', 'credential', 'write', 'interaction', 'other'];
const worseCategory = (a: ActionCategory, b: ActionCategory): ActionCategory => (CATEGORY_ORDER.indexOf(a) <= CATEGORY_ORDER.indexOf(b) ? a : b);

const MAX_TEXT = 20_000;
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() && v.length <= MAX_TEXT ? v : null);

// ---------------------------------------------------------------- shell

/** Patterns that make a shell command destructive, irreversible or production-affecting. */
const SHELL_DESTRUCTIVE: Array<[RegExp, string]> = [
  [/\brm\s+(?:[^;&|\n]*\s)?-[a-zA-Z]*[rRf]/, 'recursive / forced delete (rm -r / -f)'],
  [/\bfind\b[^;&|\n]*\s-(?:delete\b|exec(?:dir)?\s+rm\b)/, 'find … -delete'],
  [/\bxargs\b[^;&|\n]*\brm\b/, 'xargs rm'],
  [/\b(?:shred|srm|wipe)\b/, 'secure delete'],
  [/\bgit\s+push\b[^;&|\n]*(?:\s--force\b|\s--force-with-lease\b|\s-f\b|\s--delete\b|\s--mirror\b|\s\+\S|\s:\S)/, 'force / deleting git push'],
  [/\bgit\s+reset\s+[^;&|\n]*--hard\b/, 'git reset --hard'],
  [/\bgit\s+clean\s+[^;&|\n]*-[a-zA-Z]*f/, 'git clean -f'],
  [/\bgit\s+branch\s+[^;&|\n]*-(?:D\b|-delete\b[^;&|\n]*--force)/, 'git branch -D'],
  [/\bgit\s+(?:checkout|restore)\s+(?:[^;&|\n]*\s)?(?:--\s+)?\.(?:\s|$)/, 'discarding working-tree changes'],
  [/\bgit\s+stash\s+(?:drop|clear)\b/, 'dropping stashes'],
  [/\bgit\s+(?:filter-branch|filter-repo|update-ref\s+-d)\b/, 'rewriting git history'],
  [/\b(?:drop\s+(?:table|database|schema|view|index|function|role|user)|truncate\s+(?:table\s+)?\w|delete\s+from\s+\w|alter\s+table\s+\S+\s+drop\b)/i, 'destructive SQL'],
  [/\b(?:flushall|flushdb)\b/i, 'flushing a datastore'],
  [/\b(?:curl|http|https|xh)\b[^;&|\n]*(?:-X\s*|--request[=\s]+)['"]?DELETE\b/i, 'HTTP DELETE'],
  [/\b(?:sudo|doas|su\s+-)\b/, 'privilege escalation'],
  [/\b(?:mkfs\S*|fdisk|parted|diskutil\s+(?:erase\w*|partition\w*|zero\w*))\b|\bdd\b[^;&|\n]*\bof=/, 'disk-level write'],
  [/\b(?:shutdown|reboot|halt|poweroff)\b|\blaunchctl\s+(?:unload|remove|bootout)\b|\bsystemctl\s+(?:stop|disable|mask)\b/, 'stopping the system or a service'],
  [/\bchmod\s+(?:-R\s+)?[0-7]*777\b|\bchown\s+-R\b|\bcrontab\s+-r\b/, 'broad permission / ownership change'],
  [/\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/, 'piping a downloaded script into a shell'],
  [/:\(\)\s*\{\s*:\s*\|\s*:/, 'fork bomb'],
  // Production, infrastructure and package registries.
  [/\bvercel\b[^;&|\n]*(?:--prod\b|\s(?:promote|rollback|remove|rm)\b)/, 'production deploy / rollback (vercel)'],
  [/\bnetlify\s+deploy\b[^;&|\n]*--prod\b/, 'production deploy (netlify)'],
  [/\bfly(?:ctl)?\s+(?:deploy|destroy|apps\s+destroy|scale|secrets\s+unset|volumes\s+destroy)\b/, 'fly.io deploy / destroy'],
  [/\bheroku\s+(?:apps:destroy|pg:reset|releases:rollback|maintenance:on)\b|\brailway\s+(?:up|down|delete)\b/, 'hosting platform change'],
  [/\bkubectl\s+(?:delete|apply|replace|drain|scale|patch|rollout\s+undo)\b|\bhelm\s+(?:install|upgrade|uninstall|delete|rollback)\b/, 'cluster change'],
  [/\bterraform\s+(?:apply|destroy|import|taint|state\s+(?:rm|mv))\b|\bpulumi\s+(?:up|destroy)\b|\bcdk\s+(?:deploy|destroy)\b/, 'infrastructure change'],
  [/\baws\s+\S+\s+(?:delete|terminate|remove|rm|deregister|put-bucket-policy)\S*|\bgcloud\b[^;&|\n]*\s(?:delete|deploy)\b|\baz\b[^;&|\n]*\s(?:delete|deploy)\b/, 'cloud resource change'],
  [/\bdocker\s+(?:rm|rmi|system\s+prune|volume\s+(?:rm|prune)|image\s+prune|container\s+prune)\b/, 'removing containers / images / volumes'],
  [/\bsupabase\s+(?:db\s+(?:reset|push)|projects\s+delete|functions\s+delete|secrets\s+unset)\b|\bprisma\s+migrate\s+(?:reset|deploy)\b|\bprisma\s+db\s+push\b[^;&|\n]*--force-reset|\bdrizzle-kit\s+(?:drop|push)\b/, 'database migration / reset'],
  [/\b(?:npm|yarn|pnpm|bun)\s+(?:publish|unpublish|deprecate)\b|\bcargo\s+(?:publish|yank)\b|\btwine\s+upload\b|\bgem\s+(?:push|yank)\b|\bpoetry\s+publish\b/, 'publishing a package'],
  [/\bgh\s+(?:repo\s+(?:delete|archive|rename|edit)|release\s+(?:create|delete|edit)|pr\s+(?:merge|close)|issue\s+(?:delete|close|transfer)|secret\s+(?:set|delete|remove)|variable\s+(?:set|delete)|workflow\s+(?:run|disable)|run\s+(?:cancel|rerun|delete))\b/, 'GitHub repo / release / merge change'],
  [/\bgh\s+api\b[^;&|\n]*(?:-X\s*|--method[=\s]+)['"]?DELETE\b/i, 'GitHub API DELETE'],
];

/** Shipping data off the machine in a way no recipient gate can see. */
const SHELL_EGRESS = /\b(?:curl|xh|http|https)\b[^;&|\n]*(?:\s-d\b|\s-d\S|--data\S*|\s-F\b|--form\b|\s-T\b|--upload-file\b|--json\b|(?:-X\s*|--request[=\s]+)['"]?(?:POST|PUT|PATCH)\b)|\bwget\b[^;&|\n]*--post-|\b(?:nc|ncat|netcat|socat|telnet|scp|sftp|ftp|rsync)\s|\bssh\s+\S/i;

/** Commands that only inspect. A pipeline / list made only of these (and no file redirection) is a read. */
const READ_COMMANDS = new Set([
  'ls', 'll', 'la', 'cat', 'bat', 'head', 'tail', 'less', 'more', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'fd', 'find', 'tree', 'wc',
  'sort', 'uniq', 'cut', 'tr', 'jq', 'yq', 'awk', 'gawk', 'column', 'nl', 'fold', 'rev', 'paste', 'join', 'echo', 'printf', 'pwd', 'cd', 'pushd',
  'popd', 'which', 'whereis', 'type', 'command', 'hash', 'whoami', 'id', 'groups', 'uname', 'sw_vers', 'date', 'cal', 'uptime', 'env', 'printenv',
  'hostname', 'file', 'stat', 'du', 'df', 'diff', 'cmp', 'comm', 'basename', 'dirname', 'realpath', 'readlink', 'test', '[', '[[', 'true', 'false',
  'sleep', 'ps', 'pgrep', 'lsof', 'xxd', 'od', 'hexdump', 'strings', 'md5', 'md5sum', 'shasum', 'sha1sum', 'sha256sum', 'cksum', 'base64',
  'dig', 'nslookup', 'host', 'ping', 'traceroute', 'whois', 'locale', 'getconf', 'sysctl', 'ulimit', 'set', 'export', 'local', 'read',
  'man', 'help', 'tldr', 'time', 'timeout', 'nproc', 'free', 'vm_stat', 'top', 'htop', 'xargs', 'sed', 'zcat', 'gzcat', 'unzip', 'tar', 'exit',
]);
const GIT_READ = new Set([
  'status', 'log', 'diff', 'show', 'remote', 'rev-parse', 'ls-files', 'ls-tree', 'ls-remote', 'blame', 'describe', 'shortlog', 'reflog',
  'grep', 'cat-file', 'fetch', 'branch', 'tag', 'config', 'version', 'help', 'whatchanged', 'rev-list', 'merge-base', 'name-rev', 'for-each-ref',
  'show-ref', 'count-objects', 'fsck', 'worktree', 'stash', 'submodule', 'check-ignore', 'var',
]);
const PKG_READ = new Set(['ls', 'list', 'view', 'info', 'show', 'outdated', 'audit', 'why', 'explain', 'search', 'config', 'root', 'bin', 'prefix', 'doctor', 'whoami', 'help']);
const GH_READ_VERBS = new Set(['view', 'list', 'status', 'diff', 'checks', 'search', 'browse']);
const VERSION_FLAG = /^(?:--version|-v|-V|version|--help|-h|help)$/;

/**
 * Split a shell line into simple commands (pipes, lists, subshells), quote-aware,
 * plus the line with quoted text blanked out (for redirect detection). Good
 * enough for classification; anything it cannot make sense of reads as a write.
 */
function shellSegments(cmd: string): { segments: string[][]; unquoted: string } {
  const segments: string[][] = [];
  let words: string[] = [];
  let word = '';
  let hasWord = false;
  let unquoted = '';
  let quote: '"' | "'" | null = null;
  const endWord = (): void => {
    if (hasWord) words.push(word);
    word = '';
    hasWord = false;
  };
  const endSegment = (): void => {
    endWord();
    // Leading `VAR=value` assignments are not the command.
    while (words.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  const src = cmd.replace(/\\\n/g, ' ').replace(/\d*>&\d+|&>/g, ' ');
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < src.length) word += src[++i];
      else word += c;
      unquoted += ' ';
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      hasWord = true;
      unquoted += ' ';
      continue;
    }
    unquoted += c;
    if (c === '\\' && i + 1 < src.length) {
      word += src[++i];
      hasWord = true;
      unquoted += ' ';
    } else if (/[|;&\n()`]/.test(c) || (c === '$' && src[i + 1] === '(')) {
      endSegment();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word += c;
      hasWord = true;
    }
  }
  endSegment();
  return { segments, unquoted };
}

/** Output redirection into a real file (not /dev/null, not fd duplication). Applied to unquoted text. */
const FILE_REDIRECT = /(?:^|[^0-9&<>=])>>?\s*(?!&|\/dev\/(?:null|stdout|stderr|tty)\b)[^\s&|;>]/;

function segmentIsRead(words: string[]): boolean {
  const [cmd0, sub, third] = words;
  const cmd = cmd0!.replace(/^.*\//, '').replace(/^['"]|['"]$/g, '');
  if (sub !== undefined && VERSION_FLAG.test(sub) && words.length === 2) return true;
  if (cmd === 'sed') return !words.some((w) => /^-[a-zA-Z]*i/.test(w) || w === '--in-place');
  if (cmd === 'tar') return words.some((w) => /^-?[a-zA-Z]*t/.test(w)) && !words.some((w) => /^-?[a-zA-Z]*[xc]/.test(w));
  if (cmd === 'unzip') return words.includes('-l') || words.includes('-t');
  if (cmd === 'find') return !words.some((w) => /^-(?:delete|exec|execdir|ok|fprint)/.test(w));
  if (cmd === 'xargs') return words.length > 1 && segmentIsRead(words.slice(1).filter((w) => !w.startsWith('-')));
  if (cmd === 'time' || cmd === 'timeout') return words.length > 1 && segmentIsRead(words.slice(cmd === 'timeout' ? 2 : 1));
  if (READ_COMMANDS.has(cmd)) return true;
  if (cmd === 'git') {
    if (sub === undefined || !GIT_READ.has(sub)) return false;
    if (sub === 'branch' || sub === 'tag') return !words.slice(2).some((w) => /^-[a-zA-Z]*[dDmMf]|^--(?:delete|move|force)/.test(w)) && (sub === 'branch' || words.length <= 3 || words.includes('-l') || words.includes('--list'));
    if (sub === 'config') return words.some((w) => /^--(?:get|list|get-regexp|get-all)\b|^-l$/.test(w));
    if (sub === 'stash') return third === 'list' || third === 'show';
    if (sub === 'remote') return third === undefined || third === '-v' || third === 'show' || third === 'get-url';
    if (sub === 'worktree' || sub === 'submodule') return third === 'list' || third === 'status';
    return true;
  }
  if (['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'brew', 'cargo', 'gem', 'go', 'composer', 'poetry', 'uv'].includes(cmd)) return sub !== undefined && PKG_READ.has(sub);
  if (cmd === 'gh') {
    if (sub === 'auth') return third === 'status';
    if (sub === 'api') return !words.some((w) => /^(?:-X|--method|-f|-F|--field|--raw-field|--input)/.test(w)) || words.some((w) => /^GET$/i.test(w));
    return words.slice(1, 3).some((w) => GH_READ_VERBS.has(w));
  }
  if (['curl', 'wget', 'xh', 'http', 'https'].includes(cmd)) {
    const savesFile = words.some((w, i) => /^(?:-o|--output)$/.test(w) ? words[i + 1] !== '/dev/null' : /^(?:-O|--remote-name|-X|--request)$/.test(w));
    return !SHELL_EGRESS.test(words.join(' ')) && !savesFile;
  }
  if (['node', 'python', 'python3', 'ruby', 'deno', 'bun', 'java', 'go', 'rustc', 'tsc', 'psql', 'sqlite3', 'mysql'].includes(cmd)) {
    return sub !== undefined && VERSION_FLAG.test(sub);
  }
  if (['vercel', 'netlify', 'flyctl', 'fly', 'heroku', 'railway', 'supabase', 'kubectl', 'docker', 'terraform', 'aws', 'gcloud', 'az', 'helm'].includes(cmd)) {
    return sub !== undefined && (VERSION_FLAG.test(sub) || /^(?:ls|list|status|whoami|logs|inspect|ps|images|get|describe|show|version|info|env|plan|validate|projects|config)$/.test(sub));
  }
  return false;
}

export function assessShell(command: string): CallIntent {
  for (const [re, why] of SHELL_DESTRUCTIVE) {
    if (re.test(command)) return { level: 'destructive', category: 'destructive', egress: SHELL_EGRESS.test(command), why };
  }
  const egress = SHELL_EGRESS.test(command);
  const { segments, unquoted } = shellSegments(command);
  const read = !FILE_REDIRECT.test(unquoted) && segments.length > 0 && segments.every(segmentIsRead);
  return read
    ? { level: 'read', category: 'other', egress, why: 'read-only command' }
    : { level: 'write', category: 'write', egress, why: egress ? 'command sends data over the network' : 'ordinary command' };
}

// ---------------------------------------------------------------- HTTP / app actions

const READ_WORDS = new Set(['get', 'list', 'search', 'find', 'fetch', 'read', 'retrieve', 'query', 'view', 'describe', 'count', 'check', 'lookup', 'show', 'download', 'export', 'status', 'info', 'schema', 'schemas', 'whoami', 'me', 'preview', 'validate', 'estimate', 'summarize', 'summary']);
const ROLLBACK_WORDS = new Set(['merge', 'revoke', 'archive', 'terminate', 'cancel', 'rollback', 'reset', 'truncate', 'purge', 'wipe', 'uninstall', 'transfer', 'void', 'deactivate', 'disable', 'suspend', 'ban', 'kick']);

/** Intent of one named app action (an inner Composio slug such as `GITHUB_CREATE_ISSUE`). */
export function assessActionName(name: string, args?: unknown): CallIntent | null {
  const category = classifyAction(name, { args });
  const words = nameWords(name);
  switch (category) {
    case 'exec':
      return null;
    case 'destructive':
      return { level: 'destructive', category, egress: false, why: `${name} deletes data` };
    case 'payment':
    case 'send':
    case 'publish':
      // The dedicated gates (payment, first send to a new recipient, publish) decide.
      return { level: 'write', category, egress: false, why: `${name} (${category})` };
    default:
      if (words.some((w) => ROLLBACK_WORDS.has(w))) return { level: 'destructive', category: 'destructive', egress: false, why: `${name} is hard to undo` };
      if (category === 'other' && words.some((w) => READ_WORDS.has(w))) return { level: 'read', category: 'other', egress: false, why: `${name} reads` };
      return { level: 'write', category: 'write', egress: false, why: `${name} writes` };
  }
}

function assessHttp(method: string, target: string, toolkit: string): CallIntent {
  const m = method.toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return { level: 'read', category: 'other', egress: false, why: `${m} request` };
  if (m === 'DELETE') return { level: 'destructive', category: 'destructive', egress: false, why: 'DELETE request' };
  // What the endpoint path says (`…/messages/send`, `…/charges`) still meets the dedicated gates.
  const path = target.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0] ?? '';
  const inner = assessActionName(`${toolkit} ${path}`.replace(/[{}]/g, ' '));
  const category = inner && inner.category !== 'other' && inner.category !== 'write' && inner.level !== 'read' ? inner.category : 'write';
  const level = inner?.level === 'destructive' ? 'destructive' : 'write';
  return { level, category, egress: false, why: `${m} ${path || 'request'}`.slice(0, 200) };
}

// ---------------------------------------------------------------- code (workbench, browser evaluate)

const CODE_DESTRUCTIVE: Array<[RegExp, string]> = [
  [/\b(?:os\.(?:remove|unlink|rmdir|removedirs)|shutil\.rmtree|Path\([^)]*\)\.(?:unlink|rmdir)|\.unlink\(\)|fs\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\()/, 'deletes files'],
  [/\b(?:requests|httpx|session|client)\.delete\(|method\s*[:=]\s*['"]DELETE['"]/i, 'HTTP DELETE'],
];
const CODE_EGRESS = /\b(?:requests|httpx|session|client|aiohttp)\.(?:post|put|patch)\(|method\s*[:=]\s*['"](?:POST|PUT|PATCH)['"]|\bnavigator\.sendBeacon\(|\bnew\s+WebSocket\(|\bXMLHttpRequest\b|\bsmtplib\b|\bsocket\.socket\(/i;
const SECRET_READS = /\bdocument\.cookie\b|\b(?:local|session)Storage\b|\bindexedDB\b/;
const CODE_WRITE = /\b(?:open\([^)]*['"][wax]\+?b?['"]|\.write\(|\.submit\(\)|\.click\(\)|\.dispatchEvent\(|\.value\s*=|innerHTML\s*=|subprocess|os\.system|exec\(|eval\()/;
/** Composio-style action slugs called from inside code (`run_composio_tool("GMAIL_SEND_EMAIL", …)`). */
const SLUG = /\b[A-Z][A-Z0-9]{1,30}(?:_[A-Z0-9]{1,30}){1,8}\b/g;

function assessCode(code: string): CallIntent {
  let level: IntentLevel = 'read';
  let category: ActionCategory = 'other';
  let why = 'reads only';
  for (const [re, w] of CODE_DESTRUCTIVE) if (re.test(code)) return { level: 'destructive', category: 'destructive', egress: CODE_EGRESS.test(code), why: w };
  // Shell strings inside code (`subprocess.run("rm -rf …")`).
  const shell = SHELL_DESTRUCTIVE.find(([re]) => re.test(code));
  if (shell) return { level: 'destructive', category: 'destructive', egress: false, why: shell[1] };
  for (const slug of new Set(code.match(SLUG) ?? [])) {
    const inner = assessActionName(slug);
    if (!inner || inner.level === 'read') continue;
    level = worse(level, inner.level);
    category = worseCategory(category, inner.category);
    why = inner.why;
    if (level === 'destructive') return { level, category, egress: false, why };
  }
  const egress = CODE_EGRESS.test(code) || (SECRET_READS.test(code) && /\bfetch\(|\bImage\(\)|\.src\s*=/.test(code)) || /\bdocument\.cookie\b/.test(code);
  if (level === 'read' && (CODE_WRITE.test(code) || egress)) {
    level = 'write';
    category = worseCategory(category, 'write');
    why = egress ? 'code sends data or reads page credentials' : 'code changes state';
  }
  return { level, category, egress, why };
}

// ---------------------------------------------------------------- entry point

const SHELL_TOOL = /(?:^|_)(?:run|bash|shell|exec|execute|terminal|command|sh)(?:_|$)/;
const PROXY_TOOL = /(?:^|_)(?:proxy|request|http|fetch|api|execute)(?:_|$)/;
const EVAL_TOOL = /(?:^|_)(?:evaluate|eval|script|workbench|code|python|interpreter)(?:_|$)/;

interface InnerAction { slug: string; args: unknown }

function innerActions(args: Record<string, unknown>): InnerAction[] | null {
  const list = Array.isArray(args.tools) ? args.tools : Array.isArray(args.actions) ? args.actions : null;
  if (!list || list.length === 0 || list.length > 50) return null;
  const out: InnerAction[] = [];
  for (const item of list) {
    if (item === null || typeof item !== 'object') return null;
    const o = item as Record<string, unknown>;
    const slug = str(o.tool_slug) ?? str(o.toolSlug) ?? str(o.slug) ?? str(o.tool) ?? str(o.action) ?? str(o.name);
    if (!slug) return null;
    out.push({ slug, args: o.arguments ?? o.args ?? o.params ?? o.input });
  }
  return out;
}

/**
 * Intent of a call to an opaque executor tool, or null when the tool is not
 * one (or its arguments are unreadable) and name-based rules stay in charge.
 */
export function assessCall(toolName: string, args: Record<string, unknown>): CallIntent | null {
  const name = nameWords(toolName).join('_');

  const inner = innerActions(args);
  if (inner) {
    let acc: CallIntent | null = null;
    for (const a of inner) {
      const i = assessActionName(a.slug, a.args);
      if (!i) return null;
      acc = acc
        ? { level: worse(acc.level, i.level), category: worseCategory(acc.category, i.category), egress: acc.egress || i.egress, why: LEVEL_ORDER.indexOf(i.level) > LEVEL_ORDER.indexOf(acc.level) ? i.why : acc.why }
        : i;
    }
    return acc;
  }

  const method = str(args.method) ?? str(args.http_method) ?? str(args.httpMethod);
  const target = str(args.endpoint) ?? str(args.url) ?? str(args.path);
  if (method && target && /^[a-z]+$/i.test(method) && PROXY_TOOL.test(name)) {
    return assessHttp(method, target, str(args.toolkit_slug) ?? str(args.toolkit) ?? '');
  }

  const command = str(args.command) ?? str(args.cmd);
  if (command && SHELL_TOOL.test(name)) return assessShell(command);

  const code = str(args.code) ?? str(args.script) ?? str(args.expression) ?? str(args.source);
  if (code && EVAL_TOOL.test(name)) return assessCode(code);

  return null;
}
