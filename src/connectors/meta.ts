import type { ToolDef } from '../contracts/tools.js';
import { nameWords } from './risk.js';
import { CALL_TOOL, FIND_TOOLS, type ToolEntry } from './types.js';

/**
 * Context budget (PRD "MCP connectors"): large toolkits are not listed tool by
 * tool. The agent searches with `find_tools` and runs a match with `call_tool`,
 * which goes through exactly the same enforcement as a direct call.
 */
export function findToolsDef(largeServers: string[]): ToolDef {
  return {
    name: FIND_TOOLS,
    description:
      `Search the tools available to you by keyword and get their full schemas. Large toolkits (${largeServers.join(', ')}) ` +
      'are not listed individually: find a tool here, then run it with call_tool.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords describing what you want to do, e.g. "send email" or "list invoices".' },
        limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Maximum number of tools to return (default 8).' },
      },
      required: ['query'],
    },
    risk: 'read',
  };
}

export function callToolDef(): ToolDef {
  return {
    name: CALL_TOOL,
    description: 'Run a tool returned by find_tools. The same permissions and approval rules apply as for any other tool.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The exact tool name returned by find_tools, e.g. "gmail__send_email".' },
        arguments: { type: 'object', description: 'Arguments matching that tool\'s input schema.' },
      },
      required: ['name'],
    },
    risk: 'read',
  };
}

const words = (text: string): string[] => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/** Keyword-ranked search over the name and description of the caller's permitted tools. */
export function searchTools(entries: ToolEntry[], query: string, limit = 8): ToolEntry[] {
  const terms = [...new Set(words(query))];
  if (terms.length === 0) return [];
  const max = Math.min(Math.max(Math.trunc(limit) || 8, 1), 25);
  const scored: Array<{ entry: ToolEntry; score: number }> = [];
  for (const entry of entries) {
    const name = new Set([...nameWords(entry.def.name), ...nameWords(entry.serverName)]);
    const lowerName = entry.qualified.toLowerCase();
    const desc = new Set(words(entry.def.description));
    let score = 0;
    let hits = 0;
    for (const t of terms) {
      const s = name.has(t) ? 4 : lowerName.includes(t) ? 2 : desc.has(t) ? 1 : 0;
      if (s > 0) hits++;
      score += s;
    }
    // Prefer tools matching more of the query over a strong match on one word.
    if (score > 0) scored.push({ entry, score: score + hits * 2 });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.entry.qualified.localeCompare(b.entry.qualified))
    .slice(0, max)
    .map((s) => s.entry);
}
