/**
 * Read-only previews of Office Open XML files (docx, xlsx, pptx) without a
 * library: a minimal ZIP reader over the browser's `DecompressionStream` and
 * `DOMParser` on the parts. Output is plain data rendered as React elements,
 * so nothing in a document can become markup or script.
 */

const u16 = (b: Uint8Array, at: number): number => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number): number => (u16(b, at) | (u16(b, at + 2) << 16)) >>> 0;

interface Entry { method: number; size: number; offset: number }

/** Central directory: file name → where its data is. */
function zipEntries(b: Uint8Array): Map<string, Entry> {
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65_557); i--) {
    if (u32(b, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This file is not a readable Office document.');
  const count = u16(b, eocd + 10);
  let at = u32(b, eocd + 16);
  const out = new Map<string, Entry>();
  const names = new TextDecoder();
  for (let n = 0; n < count && u32(b, at) === 0x02014b50; n++) {
    const nameLen = u16(b, at + 28);
    const name = names.decode(b.subarray(at + 46, at + 46 + nameLen));
    out.set(name, { method: u16(b, at + 10), size: u32(b, at + 20), offset: u32(b, at + 42) });
    at += 46 + nameLen + u16(b, at + 30) + u16(b, at + 32);
  }
  return out;
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

class Zip {
  private readonly entries: Map<string, Entry>;
  constructor(private readonly b: Uint8Array) {
    this.entries = zipEntries(b);
  }
  names(): string[] {
    return [...this.entries.keys()];
  }
  async text(name: string): Promise<string | null> {
    const e = this.entries.get(name);
    if (!e) return null;
    const start = e.offset + 30 + u16(this.b, e.offset + 26) + u16(this.b, e.offset + 28);
    const raw = this.b.subarray(start, start + e.size);
    const data = e.method === 0 ? raw : e.method === 8 ? await inflate(raw) : null;
    if (!data) throw new Error('This document uses a compression method the preview cannot read.');
    return new TextDecoder().decode(data);
  }
  async xml(name: string): Promise<Document | null> {
    const t = await this.text(name);
    return t === null ? null : new DOMParser().parseFromString(t, 'application/xml');
  }
}

const kids = (el: Element, local?: string): Element[] => [...el.children].filter((c) => !local || c.localName === local);
const desc = (el: Element | Document, local: string): Element[] => [...el.getElementsByTagNameNS('*', local)];
const attr = (el: Element | undefined, local: string): string | null => {
  if (!el) return null;
  for (const a of el.attributes) if (a.localName === local) return a.value;
  return null;
};

/* ── Word ── */

export interface Run { text: string; bold?: boolean; italic?: boolean }
export type DocBlock =
  | { type: 'p'; heading: number; list: boolean; runs: Run[] }
  | { type: 'table'; rows: string[][] };

function paragraph(p: Element): { heading: number; list: boolean; runs: Run[] } {
  const pPr = kids(p, 'pPr')[0];
  const style = attr(kids(pPr ?? p, 'pStyle')[0], 'val') ?? '';
  const h = /^(?:heading|berschrift|titre)\s*(\d)$/i.exec(style) ?? (/^title$/i.test(style) ? [style, '1'] : null);
  const runs: Run[] = [];
  for (const r of desc(p, 'r')) {
    const rPr = kids(r, 'rPr')[0];
    const on = (tag: string) => {
      const el = rPr ? kids(rPr, tag)[0] : undefined;
      return !!el && attr(el, 'val') !== '0' && attr(el, 'val') !== 'false';
    };
    let text = '';
    for (const c of kids(r)) {
      if (c.localName === 't') text += c.textContent ?? '';
      else if (c.localName === 'tab') text += '\t';
      else if (c.localName === 'br' || c.localName === 'cr') text += '\n';
    }
    if (text) runs.push({ text, bold: on('b'), italic: on('i') });
  }
  return { heading: h ? Number(h[1]) : 0, list: !!(pPr && kids(pPr, 'numPr').length), runs };
}

export async function readDocx(data: Uint8Array): Promise<DocBlock[]> {
  const doc = await new Zip(data).xml('word/document.xml');
  const body = doc ? desc(doc, 'body')[0] : undefined;
  if (!body) throw new Error('This Word document has no readable body.');
  const out: DocBlock[] = [];
  for (const el of kids(body)) {
    if (el.localName === 'p') out.push({ type: 'p', ...paragraph(el) });
    else if (el.localName === 'tbl') {
      out.push({ type: 'table', rows: kids(el, 'tr').map((tr) => kids(tr, 'tc').map((tc) => kids(tc, 'p').map((p) => paragraph(p).runs.map((r) => r.text).join('')).join('\n'))) });
    }
  }
  return out;
}

/* ── Excel ── */

export interface Sheet { name: string; rows: string[][]; truncated: boolean }
const MAX_ROWS = 1000;
const MAX_COLS = 60;

const colIndex = (ref: string): number => {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.toUpperCase().charCodeAt(0) - 64);
  return n - 1;
};

export async function readXlsx(data: Uint8Array): Promise<Sheet[]> {
  const zip = new Zip(data);
  const shared = (await zip.xml('xl/sharedStrings.xml'));
  const strings = shared ? desc(shared, 'si').map((si) => desc(si, 't').map((t) => t.textContent ?? '').join('')) : [];
  const book = await zip.xml('xl/workbook.xml');
  const rels = await zip.xml('xl/_rels/workbook.xml.rels');
  const target = new Map((rels ? desc(rels, 'Relationship') : []).map((r) => [attr(r, 'Id'), attr(r, 'Target')]));
  const sheets = book ? desc(book, 'sheet') : [];
  const out: Sheet[] = [];
  for (const s of sheets.slice(0, 30)) {
    const t = target.get(attr(s, 'id'));
    if (!t) continue;
    const path = t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`;
    const xml = await zip.xml(path);
    if (!xml) continue;
    const rows: string[][] = [];
    let truncated = false;
    for (const row of desc(xml, 'row')) {
      const r = Number(attr(row, 'r') ?? rows.length + 1) - 1;
      if (r >= MAX_ROWS) {
        truncated = true;
        break;
      }
      const cells: string[] = rows[r] ?? [];
      for (const c of kids(row, 'c')) {
        const ref = attr(c, 'r');
        const i = ref ? colIndex(ref) : cells.length;
        if (i >= MAX_COLS) {
          truncated = true;
          continue;
        }
        const type = attr(c, 't');
        const v = kids(c, 'v')[0]?.textContent ?? '';
        cells[i] = type === 's' ? strings[Number(v)] ?? '' : type === 'inlineStr' ? desc(c, 't').map((x) => x.textContent ?? '').join('') : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : v;
      }
      rows[r] = cells;
    }
    const width = Math.max(0, ...rows.map((r) => r?.length ?? 0));
    out.push({ name: attr(s, 'name') ?? `Sheet ${out.length + 1}`, rows: Array.from(rows, (r) => Array.from({ length: width }, (_, i) => r?.[i] ?? '')), truncated });
  }
  if (!out.length) throw new Error('This workbook has no readable sheets.');
  return out;
}

/* ── PowerPoint ── */

export async function readPptx(data: Uint8Array): Promise<string[][]> {
  const zip = new Zip(data);
  const slides = zip.names().filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  const out: string[][] = [];
  for (const name of slides.slice(0, 300)) {
    const xml = await zip.xml(name);
    out.push(xml ? desc(xml, 'p').map((p) => desc(p, 't').map((t) => t.textContent ?? '').join('')).filter((t) => t.trim()) : []);
  }
  if (!out.length) throw new Error('This presentation has no readable slides.');
  return out;
}
