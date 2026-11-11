import type { Kernel } from '../contracts/kernel.js';
import type { Connector } from '../contracts/rows.js';
import { SYSTEM } from '../contracts/types.js';
import { toolSchemaHash } from './risk.js';
import type { ConnectorStore } from './store.js';
import type { UpstreamTool } from './types.js';

/**
 * Schema pinning (PRD security model: "schema-change quarantine"). Each
 * upstream tool's (name, description, inputSchema) hash is pinned on first
 * sight; a different hash later quarantines the tool until a human re-trusts
 * it. Returns the names that are currently quarantined.
 */
export function syncPins(k: Kernel, store: ConnectorStore, orgId: string, connector: Connector, tools: UpstreamTool[]): Set<string> {
  const pins = new Map(store.pins(orgId, connector.id).map((p) => [p.toolName, p]));
  const quarantined = new Set<string>();
  for (const tool of tools) {
    const hash = toolSchemaHash(tool);
    const pin = pins.get(tool.name);
    if (!pin) {
      store.insertPin(orgId, connector.id, tool.name, hash);
      continue;
    }
    if (pin.status === 'trusted') {
      if (pin.schemaHash === hash) continue;
      store.patchPin(orgId, pin.id, { status: 'quarantined', pendingHash: hash });
      quarantined.add(tool.name);
      k.audit.record({
        orgId, actor: SYSTEM, action: 'tool.quarantined', entityKind: 'connector', entityId: connector.id,
        data: { tool: tool.name, connectorName: connector.name, pinnedHash: pin.schemaHash, seenHash: hash },
      });
      k.bus.emit('notification', {
        orgId,
        kind: 'tool_quarantined',
        title: `Tool "${connector.name}/${tool.name}" changed and was disabled`,
        body: 'Its upstream definition no longer matches the pinned schema. Review the change and re-trust the tool to enable it again.',
        data: { connectorId: connector.id, tool: tool.name },
      });
      continue;
    }
    if (pin.schemaHash === hash) {
      // Upstream went back to the pinned definition.
      store.patchPin(orgId, pin.id, { status: 'trusted', pendingHash: null });
      continue;
    }
    if (pin.pendingHash !== hash) store.patchPin(orgId, pin.id, { pendingHash: hash });
    quarantined.add(tool.name);
  }
  return quarantined;
}
