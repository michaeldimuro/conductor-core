import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * A small Markdown renderer for agent and human prose: headings, lists, quotes,
 * code, emphasis and links. It only ever builds React elements, so nothing an
 * agent writes can become markup or script.
 */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>)\]]+)|(\*[^*\s][^*\n]*\*)|(@[a-z0-9][a-z0-9-]*)|(\bapr_[0-9A-HJKMNP-TV-Z]{26}\b)/gi;
/** A code span that is nothing but an approval id. */
const APPROVAL_CODE = /^apr_[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Renderers for entity references inside prose. Without a provider an
 * approval id stays plain text; under one (see `ApprovalRefs`) it becomes a
 * chip that opens the request in place.
 */
export interface MarkdownRefRenderers {
  approval?: (id: string, key: string) => ReactNode;
}
export const MarkdownRefs = createContext<MarkdownRefRenderers | null>(null);

function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

function inline(text: string, key: string, refs: MarkdownRefRenderers | null): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    const tok = m[0];
    if (at > last) out.push(text.slice(last, at));
    const id = `${key}-${n++}`;
    if (m[1]) {
      const code = tok.slice(1, -1);
      out.push(refs?.approval && APPROVAL_CODE.test(code) ? refs.approval(code, id) : <code key={id}>{code}</code>);
    } else if (m[2]) out.push(<strong key={id}>{inline(tok.slice(2, -2), id, refs)}</strong>);
    else if (m[3]) {
      const split = tok.lastIndexOf('](');
      const label = tok.slice(1, split);
      const href = safeHref(tok.slice(split + 2, -1));
      out.push(href ? <a key={id} href={href} target="_blank" rel="noreferrer noopener">{label}</a> : label);
    } else if (m[4]) {
      const url = tok.replace(/[.,;:!?]+$/, '');
      out.push(<a key={id} href={url} target="_blank" rel="noreferrer noopener">{url}</a>, tok.slice(url.length));
    } else if (m[5]) out.push(<em key={id}>{inline(tok.slice(1, -1), id, refs)}</em>);
    else if (m[6] && (at === 0 || /[\s(]/.test(text[at - 1] ?? ''))) out.push(<span key={id} className="mention">{tok}</span>);
    else if (m[7] && refs?.approval && APPROVAL_CODE.test(tok)) out.push(refs.approval(tok, id));
    else out.push(tok);
    last = at + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBER = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const FENCE = /^\s*```/;
const QUOTE = /^\s*>\s?(.*)$/;

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const refs = useContext(MarkdownRefs);
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let i = 0;
  const collect = (re: RegExp): string[] => {
    const items: string[] = [];
    while (i < lines.length) {
      const m = re.exec(lines[i] ?? '');
      if (m) items.push(m[1] ?? '');
      else if (items.length > 0 && /^\s{2,}\S/.test(lines[i] ?? '')) items[items.length - 1] += ` ${(lines[i] ?? '').trim()}`;
      else break;
      i++;
    }
    return items;
  };
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const key = `b${blocks.length}`;
    if (!line.trim()) {
      i++;
    } else if (FENCE.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i] ?? '')) code.push(lines[i++] ?? '');
      i++;
      blocks.push(<pre key={key} className="code">{code.join('\n')}</pre>);
    } else if (HEADING.test(line)) {
      const m = HEADING.exec(line)!;
      blocks.push(<p key={key} className={`md-h md-h${Math.min(m[1]!.length, 3)}`}>{inline(m[2] ?? '', key, refs)}</p>);
      i++;
    } else if (BULLET.test(line)) {
      blocks.push(<ul key={key}>{collect(BULLET).map((t, n) => <li key={n}>{inline(t, `${key}-${n}`, refs)}</li>)}</ul>);
    } else if (NUMBER.test(line)) {
      blocks.push(<ol key={key}>{collect(NUMBER).map((t, n) => <li key={n}>{inline(t, `${key}-${n}`, refs)}</li>)}</ol>);
    } else if (QUOTE.test(line)) {
      blocks.push(<blockquote key={key}>{inline(collect(QUOTE).join(' '), key, refs)}</blockquote>);
    } else {
      const para: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim() && !FENCE.test(lines[i]!) && !HEADING.test(lines[i]!) && !BULLET.test(lines[i]!) && !NUMBER.test(lines[i]!) && !QUOTE.test(lines[i]!)) para.push(lines[i++]!);
      blocks.push(<p key={key}>{para.flatMap((l, n) => (n ? [<br key={`br${n}`} />, ...inline(l, `${key}-${n}`, refs)] : inline(l, `${key}-${n}`, refs)))}</p>);
    }
  }
  return <div className={`prose md ${className}`.trim()}>{blocks}</div>;
}
