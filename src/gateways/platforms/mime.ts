/** Minimal RFC 5322 / MIME: build outbound text mail, parse inbound mail into (sender, subject, text). */

import { stripControlChars } from '../util.js';

export const EMAIL_ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;

export function isEmailAddress(value: string): boolean {
  return value.length <= 254 && EMAIL_ADDRESS_RE.test(value);
}

/** RFC 2047 encoded-words for non-ASCII header text; CR/LF can never survive into a header. */
export function encodeHeaderText(text: string): string {
  const clean = stripControlChars(text.replace(/[\r\n\t]+/g, ' ')).trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return clean;
  const words: string[] = [];
  let chunk = '';
  for (const ch of clean) {
    // Each encoded-word must stay under 75 chars: ≤ 45 bytes of UTF-8 per word.
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

/** Quoted-printable with soft line breaks at 76 columns. */
export function encodeQuotedPrintable(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  return lines.map((line) => {
    const bytes = Buffer.from(line, 'utf8');
    let out = '';
    let col = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const trailingSpace = (b === 0x20 || b === 0x09) && i === bytes.length - 1;
      const literal = ((b >= 33 && b <= 126 && b !== 61) || b === 0x20 || b === 0x09) && !trailingSpace;
      const token = literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      if (col + token.length > 75) {
        out += '=\r\n';
        col = 0;
      }
      out += token;
      col += token.length;
    }
    return out;
  }).join('\r\n');
}

export interface OutboundMail {
  from: string;
  to: string;
  subject: string;
  text: string;
  date: Date;
  messageId: string;
}

/** A complete text/plain message with CRLF line endings (not yet dot-stuffed — that is SMTP's job). */
export function buildMessage(mail: OutboundMail): string {
  const headers = [
    `From: Conductor <${mail.from}>`,
    `To: <${mail.to}>`,
    `Subject: ${encodeHeaderText(mail.subject).slice(0, 900)}`,
    `Date: ${mail.date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${mail.messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    'Auto-Submitted: auto-generated',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${encodeQuotedPrintable(mail.text)}\r\n`;
}

/* ───────────────────────── inbound ───────────────────────── */

function decodeBytes(bytes: Buffer, charset: string | undefined): string {
  try {
    return new TextDecoder((charset ?? 'utf-8').toLowerCase()).decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

export function decodeQuotedPrintable(input: string): Buffer {
  const text = input.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const hex = text[i] === '=' ? text.slice(i + 1, i + 3) : '';
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(parseInt(hex, 16));
      i += 2;
    } else {
      out.push(text.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** Decode RFC 2047 encoded-words in a header value. */
export function decodeHeaderText(value: string): string {
  return value
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
      const bytes = enc.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : decodeQuotedPrintable(data.replace(/_/g, ' '));
      return decodeBytes(bytes, charset);
    });
}

interface Part {
  headers: Map<string, string>;
  body: string;
}

/** Split headers from body; header names are lower-cased, folded lines unfolded, first occurrence wins. */
function splitPart(raw: string): Part {
  const m = /\r?\n\r?\n/.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index + m[0].length) : '';
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(i + 1).trim());
  }
  return { headers, body };
}

function param(headerValue: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(headerValue);
  return m ? (m[1] ?? m[2]) : undefined;
}

function partText(part: Part, depth: number): { plain: string | null; html: string | null } {
  const type = part.headers.get('content-type') ?? 'text/plain';
  const lower = type.toLowerCase();
  if (lower.startsWith('multipart/')) {
    const boundary = param(type, 'boundary');
    if (!boundary || depth > 5) return { plain: null, html: null };
    let plain: string | null = null;
    let html: string | null = null;
    const sections = part.body.split(`--${boundary}`).slice(1);
    for (const section of sections) {
      if (section.startsWith('--')) break;
      const child = partText(splitPart(section.replace(/^\r?\n/, '')), depth + 1);
      plain ??= child.plain;
      html ??= child.html;
    }
    return { plain, html };
  }
  if (/attachment/i.test(part.headers.get('content-disposition') ?? '')) return { plain: null, html: null };
  if (!lower.startsWith('text/')) return { plain: null, html: null };
  const encoding = (part.headers.get('content-transfer-encoding') ?? '7bit').toLowerCase();
  const bytes = encoding === 'base64'
    ? Buffer.from(part.body.replace(/\s+/g, ''), 'base64')
    : encoding === 'quoted-printable' ? decodeQuotedPrintable(part.body) : Buffer.from(part.body, 'latin1');
  const text = decodeBytes(bytes, param(type, 'charset'));
  return lower.startsWith('text/html') ? { plain: null, html: text } : { plain: text, html: null };
}

function htmlToText(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>(\r?\n)?/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** Drop the quoted original and signature from a reply so only what the human just wrote remains. */
export function stripQuotedReply(text: string): string {
  const kept: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*>/.test(line)) continue;
    if (/^On .{1,200} wrote:\s*$/.test(line.trim()) || /^-{2,}\s*Original Message\s*-{2,}/i.test(line.trim()) || line === '-- ' || line === '--') break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

export interface ParsedMail {
  /** Lower-cased sender address from the From header, or null when unparseable. */
  from: string | null;
  subject: string;
  text: string;
  /** The receiving server's Authentication-Results verdicts (first header = added last, by our own MTA). */
  authResults: string;
}

export function parseMail(raw: Buffer): ParsedMail {
  // latin1 keeps bytes intact; each text part is decoded with its own charset afterwards.
  const root = splitPart(raw.toString('latin1'));
  const fromHeader = decodeHeaderText(root.headers.get('from') ?? '');
  const angle = /<([^<>\s]+)>\s*$/.exec(fromHeader);
  const candidate = (angle ? angle[1]! : fromHeader).trim().toLowerCase();
  const { plain, html } = partText(root, 0);
  return {
    from: isEmailAddress(candidate) ? candidate : null,
    subject: decodeHeaderText(root.headers.get('subject') ?? '').trim(),
    text: stripQuotedReply(plain ?? (html !== null ? htmlToText(html) : '')),
    authResults: root.headers.get('authentication-results') ?? '',
  };
}
