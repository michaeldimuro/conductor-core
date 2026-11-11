import { z } from 'zod';
import type { ToolDef, ToolRisk } from '../contracts/tools.js';
import { AUTONOMY } from '../contracts/types.js';

const ref = z.string().regex(/^(?:f\d+)?e\d+$/).describe('Element ref from the latest `snapshot`, e.g. "e12" (or "f1e3" inside an iframe).');
const selector = z.string().min(1).max(2000).describe('CSS (or Playwright) selector. Use when you have no ref.');
const target = { ref: ref.optional(), selector: selector.optional() };
const workspacePath = z.string().min(1).max(1000);

export const schemas = {
  navigate: z.strictObject({
    url: z.string().min(1).max(4000).describe('Absolute http(s) URL.'),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load'),
  }),
  snapshot: z.strictObject({}),
  click: z.strictObject({
    ...target,
    button: z.enum(['left', 'right', 'middle']).default('left'),
    doubleClick: z.boolean().default(false),
  }),
  type: z.strictObject({
    ...target,
    text: z.string().max(20_000),
    clear: z.boolean().default(true).describe('Replace the current value (default) instead of appending keystrokes.'),
    submit: z.boolean().default(false).describe('Press Enter afterwards.'),
  }),
  select: z.strictObject({
    ...target,
    values: z.array(z.string().max(1000)).min(1).max(50).describe('Option values or labels to select.'),
  }),
  screenshot: z.strictObject({
    ...target,
    fullPage: z.boolean().default(false),
    format: z.enum(['png', 'jpeg']).default('png'),
  }),
  extract: z.strictObject({
    ...target,
    kind: z.enum(['text', 'links', 'tables', 'attribute']).default('text'),
    attribute: z.string().min(1).max(100).optional().describe('Attribute name; required when kind is "attribute".'),
    all: z.boolean().default(false).describe('With a selector: return every match instead of the first.'),
    maxChars: z.number().int().min(100).max(200_000).default(40_000),
  }),
  download: z.strictObject({
    ...target,
    url: z.string().min(1).max(4000).optional().describe('Direct URL to fetch with the profile\'s cookies (alternative to clicking an element).'),
    path: workspacePath.optional().describe('Destination relative to the run workspace. Defaults to downloads/<suggested name>.'),
  }),
  upload: z.strictObject({
    ...target,
    paths: z.array(workspacePath).min(1).max(20).describe('Files relative to the run workspace.'),
  }),
  tabs: z.strictObject({
    action: z.enum(['list', 'new', 'switch', 'close']).default('list'),
    index: z.number().int().min(0).max(200).optional().describe('Tab index from `list` (switch / close).'),
    url: z.string().min(1).max(4000).optional().describe('URL to open in the new tab.'),
  }),
  evaluate: z.strictObject({
    ...target,
    script: z.string().min(1).max(20_000).describe('JavaScript expression or function. With ref/selector the function receives that element.'),
  }),
  fill_secret: z.strictObject({
    field: z.string().min(1).max(2000).describe('The input to fill: an element ref from `snapshot` or a CSS selector.'),
    secret_ref: z.string().min(1).max(500).describe('Secret reference: org/<org>/… from the secret store, or a 1Password reference op://<vault>/<item>/<field> when the owner allowed that vault. The value is never shown to you.'),
  }),
  request_human: z.strictObject({
    reason: z.string().trim().min(1).max(500).describe('What the human needs to do (log in, MFA code, CAPTCHA, consent…).'),
  }),
} as const;

export type ToolName = keyof typeof schemas;
export type ToolArgs<K extends ToolName> = z.infer<(typeof schemas)[K]>;

const TARGET_NOTE = ' Identify the element with `ref` (from snapshot) or `selector`.';

const META: Record<ToolName, { risk: ToolRisk; description: string }> = {
  navigate: { risk: 'external_read', description: 'Open a URL in the active tab. Blocked when the host is not on the profile\'s domain allowlist.' },
  snapshot: { risk: 'external_read', description: 'Accessibility tree of the active tab with stable element refs ([ref=e12]) that the other tools accept. Take a new snapshot after the page changes.' },
  click: { risk: 'external_write', description: `Click an element.${TARGET_NOTE} Submits / purchases / sends on sensitive domains need board approval first.` },
  type: { risk: 'external_write', description: `Type text into an input.${TARGET_NOTE} Never type passwords: use fill_secret.` },
  select: { risk: 'external_write', description: `Choose option(s) in a <select>.${TARGET_NOTE}` },
  screenshot: { risk: 'external_read', description: 'Screenshot of the active tab (or one element) as an image.' },
  extract: { risk: 'external_read', description: 'Extract text, links, tables or an attribute from the page or from one element (ref / selector).' },
  download: { risk: 'external_read', description: 'Download a file into the run workspace, by URL or by clicking the element that triggers the download.' },
  upload: { risk: 'external_write', description: `Attach workspace files to a file input.${TARGET_NOTE}` },
  tabs: { risk: 'external_read', description: 'List, open, switch or close browser tabs.' },
  evaluate: { risk: 'high', description: 'Run JavaScript in the page. Policy-gated: autonomy level 2+, and always needs approval on sensitive domains.' },
  fill_secret: { risk: 'external_write', description: 'Fill a credential into a field by secret reference. You never see the value; only the reference is recorded.' },
  request_human: { risk: 'write', description: 'Ask the owner to take over this browser tab (login, MFA, CAPTCHA, consent). Pauses the run until they hand control back; then continue from the same page.' },
};

/** Tools visible to a caller. `evaluate` is hidden (and refused) below autonomy level 2. */
export function toolDefs(autonomyLevel: number): ToolDef[] {
  return (Object.keys(schemas) as ToolName[])
    .filter((name) => name !== 'evaluate' || autonomyLevel >= AUTONOMY.AUTONOMOUS)
    .map((name) => {
      const { $schema: _schema, ...inputSchema } = z.toJSONSchema(schemas[name], { io: 'input' }) as Record<string, unknown>;
      return { name, description: META[name].description, inputSchema, risk: META[name].risk };
    });
}

export function isToolName(name: string): name is ToolName {
  return Object.prototype.hasOwnProperty.call(schemas, name);
}
