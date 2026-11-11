import type { ReactNode } from 'react';

/**
 * A small Markdown renderer for agent and human prose: headings, lists, quotes,
 * code, emphasis and links. It only ever builds React elements, so nothing an
 * agent writes can become markup or script.
 */
const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>)\]]+)|(\*[^*\s][^*\n]*\*)|(@[a-z0-9][a-z0-9-]*)/gi;

function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    const tok = m[0];
    if (at > last) out.push(text.slice(last, at));
    const id = `${key}-${n++}`;
    if (m[1]) out.push(<code key={id}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={id}>{inline(tok.slice(2, -2), id)}</strong>);
    else if (m[3]) {
      const split = tok.lastIndexOf('](');
      const label = tok.slice(1, split);
      const href = safeHref(tok.slice(split + 2, -1));
      out.push(href ? <a key={id} href={href} target="_blank" rel="noreferrer noopener">{label}</a> : label);
    } else if (m[4]) {
      const url = tok.replace(/[.,;:!?]+$/, '');
      out.push(<a key={id} href={url} target="_blank" rel="noreferrer noopener">{url}</a>, tok.slice(url.length));
    } else if (m[5]) out.push(<em key={id}>{inline(tok.slice(1, -1), id)}</em>);
    else if (m[6] && (at === 0 || /[\s(]/.test(text[at - 1] ?? ''))) out.push(<span key={id} className="mention">{tok}</span>);
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
      blocks.push(<p key={key} className={`md-h md-h${Math.min(m[1]!.length, 3)}`}>{inline(m[2] ?? '', key)}</p>);
      i++;
    } else if (BULLET.test(line)) {
      blocks.push(<ul key={key}>{collect(BULLET).map((t, n) => <li key={n}>{inline(t, `${key}-${n}`)}</li>)}</ul>);
    } else if (NUMBER.test(line)) {
      blocks.push(<ol key={key}>{collect(NUMBER).map((t, n) => <li key={n}>{inline(t, `${key}-${n}`)}</li>)}</ol>);
    } else if (QUOTE.test(line)) {
      blocks.push(<blockquote key={key}>{inline(collect(QUOTE).join(' '), key)}</blockquote>);
    } else {
      const para: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim() && !FENCE.test(lines[i]!) && !HEADING.test(lines[i]!) && !BULLET.test(lines[i]!) && !NUMBER.test(lines[i]!) && !QUOTE.test(lines[i]!)) para.push(lines[i++]!);
      blocks.push(<p key={key}>{para.flatMap((l, n) => (n ? [<br key={`br${n}`} />, ...inline(l, `${key}-${n}`)] : inline(l, `${key}-${n}`)))}</p>);
    }
  }
  return <div className={`prose md ${className}`.trim()}>{blocks}</div>;
}
