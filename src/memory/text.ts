/** Text normalisation shared by the local embedder, FTS query builder and heuristics. */

export const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an and are as at be been but by can could did do does for from had has have he her his how i if in into is it its ' +
    'me my no not of on or our she so than that the their them then there these they this to too us was we were what when ' +
    'where which who will with would you your about after all also any because before both each just more most other some ' +
    'such only own same very s t don should now over under again once here why up down out off per via am being having'
  ).split(' '),
);

/** Lowercased alphanumeric tokens (accents folded). */
export function tokenize(text: string): string[] {
  return (
    text
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  );
}

/** Light suffix stripping so "exports"/"exported"/"exporting" share a feature. */
export function stem(word: string): string {
  let w = word;
  if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
  else if (w.length > 4 && w.endsWith('sses')) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us')) w = w.slice(0, -1);
  if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2);
  else if (w.length > 4 && w.endsWith('ly')) w = w.slice(0, -2);
  if (w.length > 4 && w.endsWith('e')) w = w.slice(0, -1);
  return w;
}

/** Stemmed content words (stopwords removed); figures and identifiers are kept verbatim. */
export function contentTokens(text: string): string[] {
  return tokenize(text)
    .filter((t) => /\d/.test(t) || (t.length > 1 && !STOPWORDS.has(t)))
    .map((t) => (/\d/.test(t) ? t : stem(t)));
}

/** Build a safe FTS5 MATCH expression (OR of quoted terms) from free text; null when nothing searchable. */
export function ftsQuery(text: string, maxTerms = 24): string | null {
  const terms = [...new Set(tokenize(text).filter((t) => t.length > 1 && !STOPWORDS.has(t)))].slice(0, maxTerms);
  return terms.length > 0 ? terms.map((t) => `"${t}"`).join(' OR ') : null;
}

export function normalizeEntity(entity: string | null | undefined): string | null {
  if (!entity) return null;
  const e = entity.trim().toLowerCase().replace(/\s+/g, ' ');
  return e.length > 0 ? e.slice(0, 120) : null;
}

/** True when `entity` appears in `text` as a whole token sequence. */
export function mentionsEntity(text: string, entity: string): boolean {
  const hay = ` ${tokenize(text).join(' ')} `;
  const needle = tokenize(entity).join(' ');
  return needle.length > 0 && hay.includes(` ${needle} `);
}

/**
 * Entity candidates in free text: capitalised phrases, e-mail addresses and
 * domains, lowercased. Used to match `memories.entity` and by offline extraction.
 */
export function extractEntityCandidates(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) out.add(m[0].toLowerCase());
  for (const m of text.matchAll(/\b(?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|ai|co|app)\b/gi)) out.add(m[0].toLowerCase());
  for (const m of text.matchAll(/\b[A-Z][A-Za-z0-9&-]*(?:\s+[A-Z][A-Za-z0-9&-]*){0,3}/g)) {
    const phrase = m[0].trim();
    const words = phrase.split(/\s+/);
    // A lone capitalised stopword ("The", "When") at a sentence start is not an entity.
    if (words.length === 1 && (STOPWORDS.has(phrase.toLowerCase()) || phrase.length < 3)) continue;
    out.add(phrase.toLowerCase());
    if (words.length > 1 && STOPWORDS.has((words[0] ?? '').toLowerCase())) out.add(words.slice(1).join(' ').toLowerCase());
  }
  return [...out];
}

export function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

/** Parse a JSON object out of model output, tolerating ``` fences and surrounding prose. */
export function parseJsonLoose(text: string): unknown | null {
  const candidates: string[] = [text.trim()];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v: unknown = JSON.parse(c);
      if (v !== null && typeof v === 'object') return v;
    } catch {}
  }
  return null;
}
