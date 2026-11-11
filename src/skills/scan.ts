import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Skill } from '../contracts/rows.js';
import { listSkillFiles } from './format.js';

/**
 * Static scan run on every agent write / import and before activation
 * (PRD "Safety rails"): secrets and shell-escalation patterns block
 * activation, outbound URLs are listed as warnings.
 */
export type ScanFinding = Skill['scanFindings'][number];

interface LineRule {
  rule: string;
  severity: ScanFinding['severity'];
  re: RegExp;
  /** Secrets are never echoed into findings. */
  secret?: boolean;
}

const HOME = String.raw`(?:~|\$HOME|\$\{HOME\}|\/Users\/[^\/\s"']+|\/home\/[^\/\s"']+|\/root)`;
const SHELL = String.raw`(?:sudo\s+)?(?:\/(?:usr\/)?bin\/)?(?:ba|z|k|da|fi)?sh\b`;
const FETCH = String.raw`(?:curl|wget)\b`;

const RULES: LineRule[] = [
  // ── secrets ──
  { rule: 'secret.anthropic-key', severity: 'block', secret: true, re: /sk-ant-[A-Za-z0-9_-]{16,}/ },
  { rule: 'secret.openai-key', severity: 'block', secret: true, re: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}/ },
  { rule: 'secret.github-token', severity: 'block', secret: true, re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/ },
  { rule: 'secret.slack-token', severity: 'block', secret: true, re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { rule: 'secret.aws-access-key', severity: 'block', secret: true, re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { rule: 'secret.google-api-key', severity: 'block', secret: true, re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { rule: 'secret.stripe-key', severity: 'block', secret: true, re: /\b[sr]k_live_[A-Za-z0-9]{16,}/ },
  { rule: 'secret.telegram-bot-token', severity: 'block', secret: true, re: /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/ },
  { rule: 'secret.bearer-token', severity: 'block', secret: true, re: /\bBearer\s+[A-Za-z0-9._~+/=-]{24,}/ },
  { rule: 'secret.private-key', severity: 'block', secret: true, re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  {
    rule: 'secret.hardcoded-credential',
    severity: 'block',
    secret: true,
    re: /\b(?:api[_-]?key|secret|token|passwd|password|auth)[A-Za-z0-9_]*["']?\s*[:=]\s*["'][A-Za-z0-9_\-/+=.]{20,}["']/i,
  },
  // ── shell escalation ──
  { rule: 'shell.sudo', severity: 'block', re: /(?:^|[\s;&|`$("'])sudo\s+[-\w/.]/ },
  { rule: 'shell.pipe-to-shell', severity: 'block', re: new RegExp(String.raw`${FETCH}[^\n|]*\|\s*(?:${SHELL}|python[0-9.]*\b|node\b|perl\b|ruby\b)`) },
  { rule: 'shell.fetch-and-exec', severity: 'block', re: new RegExp(String.raw`${SHELL}\s+(?:-c\s+["']?\$\(\s*${FETCH}|<\(\s*${FETCH})`) },
  {
    rule: 'shell.rm-rf-root',
    severity: 'block',
    re: /\brm\s+(?:-{1,2}[A-Za-z-]+\s+)*-[A-Za-z]*(?:r[A-Za-z]*f|f[A-Za-z]*r)[A-Za-z]*\s+(?:-{1,2}[A-Za-z-]+\s+)*["']?(?:\/\*?|(?:~|\$HOME|\$\{HOME\})(?:\/\*?)?)(?=["'\s;&|)]|$)/,
  },
  { rule: 'shell.chmod-777', severity: 'block', re: /\bchmod\s+(?:-[A-Za-z]+\s+)*(?:0?777|a\+rwx|ugo\+rwx)\b/ },
  { rule: 'shell.ssh-keys', severity: 'block', re: new RegExp(String.raw`${HOME}\/\.ssh\b|\bid_(?:rsa|ed25519|ecdsa|dsa)\b`) },
  { rule: 'shell.cloud-credentials', severity: 'block', re: new RegExp(String.raw`${HOME}\/(?:\.aws\/credentials|\.netrc|\.config\/gcloud)\b`) },
  {
    rule: 'shell.keychain',
    severity: 'block',
    re: /\bsecurity\s+(?:find-(?:generic|internet)-password|dump-keychain|export|unlock-keychain)\b|Library\/Keychains|login\.keychain/,
  },
  { rule: 'shell.base64-to-shell', severity: 'block', re: new RegExp(String.raw`base64\s+(?:-d|-D|--decode)\b[^\n|]*\|\s*${SHELL}`) },
  {
    rule: 'shell.eval-fetched',
    severity: 'block',
    re: new RegExp(
      String.raw`\beval\s+["'\x60]?\$\(\s*${FETCH}|\beval\s+["']?\x60\s*${FETCH}|\b(?:eval|exec)\s*\(\s*(?:await\s+)?(?:\(\s*await\s+)?(?:fetch|requests\.get|urllib\.request\.urlopen|urlopen|http\.get|axios\.get)\b`,
    ),
  },
  {
    rule: 'shell.env-exfiltration',
    severity: 'block',
    re: new RegExp(
      [
        String.raw`\b(?:env|printenv|export\s+-p)\b[^\n|]*\|\s*(?:${FETCH}|nc\b|ncat\b|netcat\b)`,
        String.raw`\bcat\s+[^\n|]*\.env\b[^\n|]*\|\s*(?:${FETCH}|nc\b|ncat\b)`,
        String.raw`${FETCH}[^\n]*\$\(\s*(?:env|printenv)\b`,
        String.raw`\bcurl\b[^\n]*(?:-d|--data(?:-[a-z]+)?|-F|--form|-H|--header)\s*["']?[^\n]*\$\{?[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*\}?`,
        String.raw`JSON\.stringify\(\s*process\.env\s*\)`,
        String.raw`(?:requests\.(?:post|put)|urlopen|fetch|axios\.(?:post|put))\s*\([^\n]*(?:os\.environ|process\.env)\b`,
      ].join('|'),
    ),
  },
];

const URL_RE = /\bhttps?:\/\/[^\s"'`<>)\]}]+/gi;
const LOCAL_HOST_RE = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?:[:/]|$)/i;
const MAX_FINDINGS = 200;
const MAX_URLS = 50;
const MAX_SCAN_BYTES = 1024 * 1024;

export interface ScanInput {
  path: string;
  text: string;
}

function excerpt(line: string): string {
  const s = line.trim().replace(/\s+/g, ' ');
  return s.length <= 120 ? s : `${s.slice(0, 119)}…`;
}

export function scanFiles(files: ScanInput[]): ScanFinding[] {
  const findings: ScanFinding[] = [];
  const seen = new Set<string>();
  const urls = new Set<string>();
  const push = (f: ScanFinding): void => {
    const key = `${f.rule}\0${f.detail}`;
    if (seen.has(key) || findings.length >= MAX_FINDINGS) return;
    seen.add(key);
    findings.push(f);
  };

  for (const file of files) {
    const lines = file.text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.length > 20_000) return;
      for (const r of RULES) {
        if (!r.re.test(line)) continue;
        const where = `${file.path}:${i + 1}`;
        push({ rule: r.rule, severity: r.severity, detail: r.secret ? `${where}: credential-like value (redacted)` : `${where}: ${excerpt(line)}` });
      }
      for (const m of line.matchAll(URL_RE)) {
        const url = m[0].replace(/[.,;:!?]+$/, '');
        if (LOCAL_HOST_RE.test(url)) continue;
        if (urls.size < MAX_URLS && !urls.has(url)) {
          urls.add(url);
          push({ rule: 'network.outbound-url', severity: 'warn', detail: `${file.path}:${i + 1}: ${url.slice(0, 200)}` });
        }
      }
    });
  }
  return findings;
}

export interface DirScan {
  findings: ScanFinding[];
  hasScripts: boolean;
}

/** Scan every file of a skill folder as it exists on disk. */
export function scanSkillDir(dir: string): DirScan {
  const inputs: ScanInput[] = [];
  const extra: ScanFinding[] = [];
  let hasScripts = false;
  for (const rel of listSkillFiles(dir)) {
    const inScripts = rel.startsWith('scripts/');
    if (inScripts) hasScripts = true;
    const bytes = readFileSync(join(dir, rel));
    const binary = bytes.subarray(0, 8000).includes(0);
    if (binary || bytes.length > MAX_SCAN_BYTES) {
      if (inScripts) extra.push({ rule: 'scripts.unscannable-file', severity: 'warn', detail: `${rel}: ${binary ? 'binary' : 'oversized'} file under scripts/ was not scanned` });
      continue;
    }
    inputs.push({ path: rel, text: bytes.toString('utf8') });
  }
  const findings = [...scanFiles(inputs), ...extra];
  if (hasScripts) findings.push({ rule: 'scripts.present', severity: 'info', detail: 'skill ships scripts/ — they run only inside the agent sandbox' });
  return { findings, hasScripts };
}

export const hasBlockingFinding = (findings: ScanFinding[]): boolean => findings.some((f) => f.severity === 'block');
