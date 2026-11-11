import type { ConnectorTemplate } from '../contracts/services.js';
import type { ToolPolicy } from '../contracts/types.js';

/** send / post / pay / delete style actions ask first by default (glob keys, matched case-insensitively). */
const GUARDED: Record<string, ToolPolicy> = {
  '*send*': 'ask',
  '*post*': 'ask',
  '*publish*': 'ask',
  '*pay*': 'ask',
  '*purchase*': 'ask',
  '*charge*': 'ask',
  '*refund*': 'ask',
  '*delete*': 'ask',
  '*remove*': 'ask',
};

const guarded = (extra: Record<string, ToolPolicy> = {}): Record<string, ToolPolicy> => ({ ...GUARDED, ...extra });

/**
 * Catalog templates (PRD "Catalog parity with Paperclip", FR-11). Config never
 * holds a secret: values are `{ secretRef: '<NAME>' }`, resolved under the
 * connector's (or grant's) auth ref at connect time.
 */
const TEMPLATES: ConnectorTemplate[] = [
  {
    id: 'composio',
    name: 'Composio',
    description: 'Hundreds of SaaS toolkits through Composio\'s MCP endpoint, one Composio entity per org or per agent.',
    kind: 'composio',
    category: 'toolkit',
    config: { toolkit: 'composio', entityMode: 'org', apiKeyRef: 'COMPOSIO_API_KEY' },
    requiredSecrets: ['COMPOSIO_API_KEY'],
    suggestedPolicies: guarded({ '*reply*': 'ask', '*create*': 'ask' }),
    docsUrl: 'https://docs.composio.dev/docs/mcp-overview',
  },
  {
    id: 'arcade',
    name: 'Arcade',
    description: 'Arcade.dev tools with per-user, just-in-time OAuth; authorization prompts surface as Approvals.',
    kind: 'arcade',
    category: 'toolkit',
    config: { gateway: 'default', userMode: 'org', apiKeyRef: 'ARCADE_API_KEY' },
    requiredSecrets: ['ARCADE_API_KEY'],
    suggestedPolicies: guarded({ '*reply*': 'ask' }),
    docsUrl: 'https://docs.arcade.dev/home/mcp-gateways',
  },
  {
    id: 'zapier',
    name: 'Zapier',
    description: 'Zapier MCP endpoint: every action enabled on your Zapier MCP server becomes a tool.',
    kind: 'mcp_http',
    category: 'automation',
    // Zapier issues a personal server URL that embeds its credential, so the URL itself is the secret.
    config: { url: { secretRef: 'ZAPIER_MCP_URL' } },
    requiredSecrets: ['ZAPIER_MCP_URL'],
    suggestedPolicies: guarded(),
    docsUrl: 'https://zapier.com/mcp',
  },
  {
    id: 'make',
    name: 'Make',
    description: 'Make MCP endpoint: run your on-demand scenarios as tools.',
    kind: 'mcp_http',
    category: 'automation',
    config: { url: { secretRef: 'MAKE_MCP_URL' } },
    requiredSecrets: ['MAKE_MCP_URL'],
    suggestedPolicies: guarded({ '*run*': 'ask' }),
    docsUrl: 'https://developers.make.com/mcp-server',
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub\'s official remote MCP server (repos, issues, pull requests, actions).',
    kind: 'mcp_http',
    category: 'dev',
    config: { url: 'https://api.githubcopilot.com/mcp/', auth: { type: 'bearer', secretRef: 'GITHUB_PERSONAL_ACCESS_TOKEN' } },
    requiredSecrets: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
    suggestedPolicies: guarded({ '*merge*': 'ask', '*push*': 'ask' }),
    docsUrl: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'linear',
    name: 'Linear',
    description: 'Linear\'s official remote MCP server (issues, projects, comments).',
    kind: 'mcp_http',
    category: 'productivity',
    config: { url: 'https://mcp.linear.app/mcp', auth: { type: 'bearer', secretRef: 'LINEAR_API_KEY' } },
    requiredSecrets: ['LINEAR_API_KEY'],
    suggestedPolicies: guarded(),
    docsUrl: 'https://linear.app/docs/mcp',
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Notion\'s official MCP server (stdio package) using an internal integration token.',
    kind: 'mcp_stdio',
    category: 'productivity',
    config: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: { secretRef: 'NOTION_TOKEN' } } },
    requiredSecrets: ['NOTION_TOKEN'],
    suggestedPolicies: guarded(),
    docsUrl: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Slack\'s official remote MCP server (search, read and send messages) with an OAuth user token.',
    kind: 'mcp_http',
    category: 'comms',
    config: { url: 'https://mcp.slack.com/mcp', auth: { type: 'oauth', secretRef: 'SLACK_ACCESS_TOKEN' } },
    requiredSecrets: ['SLACK_ACCESS_TOKEN'],
    suggestedPolicies: guarded({ '*reply*': 'ask', '*schedule*': 'ask' }),
    docsUrl: 'https://docs.slack.dev/ai/mcp-server',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    description: 'Stripe\'s official remote MCP server. Use a restricted API key.',
    kind: 'mcp_http',
    category: 'payments',
    config: { url: 'https://mcp.stripe.com', auth: { type: 'bearer', secretRef: 'STRIPE_SECRET_KEY' } },
    requiredSecrets: ['STRIPE_SECRET_KEY'],
    suggestedPolicies: guarded({ '*create*': 'ask', '*update*': 'ask', '*cancel*': 'ask', '*finalize*': 'ask' }),
    docsUrl: 'https://docs.stripe.com/mcp',
  },
  {
    id: 'honcho',
    name: 'Honcho',
    description: 'Honcho user-modelling memory as an external memory backend and tool set.',
    kind: 'mcp_http',
    category: 'memory',
    config: { url: 'https://mcp.honcho.dev', auth: { type: 'bearer', secretRef: 'HONCHO_API_KEY' }, memoryBackend: true },
    requiredSecrets: ['HONCHO_API_KEY'],
    suggestedPolicies: guarded(),
    docsUrl: 'https://docs.honcho.dev/v3/guides/integrations/mcp',
  },
  {
    id: 'mem0',
    name: 'Mem0',
    description: 'Mem0 long-term memory as an external memory backend and tool set (official stdio server).',
    kind: 'mcp_stdio',
    category: 'memory',
    config: { command: 'uvx', args: ['mem0-mcp-server'], env: { MEM0_API_KEY: { secretRef: 'MEM0_API_KEY' } }, memoryBackend: true },
    requiredSecrets: ['MEM0_API_KEY'],
    suggestedPolicies: guarded(),
    docsUrl: 'https://docs.mem0.ai/platform/mem0-mcp',
  },
  {
    id: 'zep',
    name: 'Zep',
    description: 'Zep temporal knowledge-graph memory as an external memory backend and tool set.',
    kind: 'mcp_stdio',
    category: 'memory',
    config: { command: 'uvx', args: ['zep-mcp-server'], env: { ZEP_API_KEY: { secretRef: 'ZEP_API_KEY' } }, memoryBackend: true },
    requiredSecrets: ['ZEP_API_KEY'],
    suggestedPolicies: guarded(),
    docsUrl: 'https://help.getzep.com/mcp-server',
  },
  {
    id: 'supermemory',
    name: 'Supermemory',
    description: 'Supermemory universal memory as an external memory backend and tool set.',
    kind: 'mcp_http',
    category: 'memory',
    config: { url: 'https://mcp.supermemory.ai/mcp', auth: { type: 'bearer', secretRef: 'SUPERMEMORY_API_KEY' }, memoryBackend: true },
    requiredSecrets: ['SUPERMEMORY_API_KEY'],
    suggestedPolicies: guarded({ '*forget*': 'ask' }),
    docsUrl: 'https://supermemory.ai/docs/supermemory-mcp/introduction',
  },
];

export function connectorCatalog(): ConnectorTemplate[] {
  return structuredClone(TEMPLATES);
}

export function findTemplate(id: string | null | undefined): ConnectorTemplate | undefined {
  return id ? TEMPLATES.find((t) => t.id === id) : undefined;
}
