/**
 * Functions evaluated inside the page. Their bodies are constant source
 * strings (the daemon is compiled without DOM typings) turned into real
 * functions once at load, so Playwright serializes and calls them in the page
 * with the element / argument it is given. Never built from caller input.
 */
const pageFn = <A extends unknown[], R>(source: string): ((...args: A) => R) =>
  new Function(`return (${source});`)() as (...args: A) => R;

const SECRET_SELECTOR = 'input[type=password],[data-conductor-secret]';

/** () => string[] — current values of password inputs and fields filled by `fill_secret`. */
export const SENSITIVE_VALUES_JS = pageFn<[], string[]>(`() => Array.from(document.querySelectorAll(${JSON.stringify(SECRET_SELECTOR)}))
  .map((e) => e.value).filter((v) => typeof v === 'string' && v.length > 0)`);

/** (el) => void — tag a field as secret-bearing so reads mask it. */
export const MARK_SECRET_JS = pageFn<[unknown], void>(`(el) => { el.setAttribute('data-conductor-secret', '1'); }`);

/** (el, key) => void — park an element on window so an agent script (evaluated as a string) can receive it. */
export const STASH_ELEMENT_JS = pageFn<[unknown, string], void>(`(el, key) => { window[key] = el; }`);

/** Locator selector for everything that must be masked in screenshots. */
export const SECRET_FIELDS_SELECTOR = SECRET_SELECTOR;

/** (el) => ElementDescriptor — what a click on this element would activate. */
export const DESCRIBE_ELEMENT_JS = pageFn<[unknown], ElementDescriptor>(`(node) => {
  const el = (node.closest && node.closest('button, a[href], input, select, textarea, [role=button], [role=link], [role=menuitem]')) || node;
  const tag = (el.tagName || '').toLowerCase();
  const attr = (n) => (el.getAttribute && el.getAttribute(n)) || '';
  const type = tag === 'button' ? (attr('type') || 'submit').toLowerCase() : tag === 'input' ? (attr('type') || 'text').toLowerCase() : '';
  const form = el.form || (el.closest && el.closest('form')) || null;
  const raw = tag === 'input' ? (el.value || attr('alt') || '') : (el.innerText || el.textContent || '');
  const text = (raw || attr('aria-label') || attr('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
  const submits = !!form && ((tag === 'button' && type === 'submit') || (tag === 'input' && (type === 'submit' || type === 'image')));
  let formAction = null;
  if (form) { try { formAction = new URL(form.getAttribute('action') || '', document.baseURI).href; } catch (e) { formAction = null; } }
  return {
    tag, type, role: attr('role'), text, name: attr('name'), id: el.id || '',
    label: (attr('aria-label') || attr('title')).slice(0, 80), submits, inForm: !!form, formAction,
    href: tag === 'a' ? (el.href || null) : null,
  };
}`);

/** (root) => {text, href}[] */
export const LINKS_JS = pageFn<[unknown], Array<{ text: string; href: string }>>(`(root) => {
  const list = Array.from(root.querySelectorAll('a[href]'));
  if (root.matches && root.matches('a[href]')) list.unshift(root);
  return list.slice(0, 500).map((a) => ({ text: (a.innerText || a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200), href: a.href }));
}`);

/** (root) => string[][][] — each table as rows of cell text. */
export const TABLES_JS = pageFn<[unknown], string[][][]>(`(root) => {
  const tables = root.matches && root.matches('table') ? [root] : Array.from(root.querySelectorAll('table'));
  return tables.slice(0, 20).map((t) => Array.from(t.rows).slice(0, 500).map((r) =>
    Array.from(r.cells).map((c) => (c.innerText || c.textContent || '').replace(/\\s+/g, ' ').trim())));
}`);

/** (elements, name) => (string|null)[] — attribute (or same-named property); secret fields never yield their value. */
export const ATTRIBUTES_JS = pageFn<[unknown[], string], Array<string | null>>(`(els, name) => els.slice(0, 500).map((el) => {
  const secret = el.matches(${JSON.stringify(SECRET_SELECTOR)});
  if (secret && name.toLowerCase() === 'value') return '[REDACTED]';
  const a = el.getAttribute(name);
  if (a !== null) return a;
  const p = el[name];
  return typeof p === 'string' || typeof p === 'number' || typeof p === 'boolean' ? String(p) : null;
})`);

export interface ElementDescriptor {
  tag: string;
  type: string;
  role: string;
  text: string;
  name: string;
  id: string;
  label: string;
  submits: boolean;
  inForm: boolean;
  formAction: string | null;
  href: string | null;
}
