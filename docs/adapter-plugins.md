# Writing a provider adapter plugin

An adapter connects Conductor to one model provider or agent runtime. Six are built in (`claude_local`, `codex_local`, `claude_api`, `openai_api`, `process`, `http`). A plugin adds another without changing or rebuilding Conductor.

Before writing one, check whether the built-in `process` adapter (runs any command) or `http` adapter (calls any webhook) already covers your case.

A complete working example is in `examples/adapters/echo-adapter/` of the installed package.

## Install and manage

A plugin is a folder inside the adapters directory of the Conductor home:

```text
~/.conductor/adapters/
  my-adapter/
    conductor-adapter.json     # manifest (required)
    index.mjs                  # entry module named by the manifest
  @scope/other-adapter/        # scoped folders are scanned too
```

To install, copy the folder there. The daemon watches the directory and loads the plugin without a restart. If it did not notice, or to see why a plugin was skipped:

```sh
conductor adapter rescan     # load plugins added to the folder; reports added, removed and skipped
conductor adapter list       # built-in and plugin adapters
conductor adapter test <id>  # run the adapter's connection test (exit code 1 on failure)
```

To use it, name its id as the provider of an agent or organization, for example `conductor agent hire --provider <id[:model]>`.

To remove it, delete the folder. To update it, replace the files; the entry module is reloaded when its modification time changes.

A plugin that fails to load is skipped and logged; it never stops the daemon or the other adapters.

## Manifest: `conductor-adapter.json`

```json
{
  "id": "my_agent",
  "name": "My Agent",
  "version": "1.0.0",
  "entry": "index.mjs",
  "configSchema": { "type": "object", "properties": { "endpoint": { "type": "string" } } },
  "capabilities": { "tools": true, "mcp": true, "resume": false, "vision": false, "browser": "via_mcp" },
  "secretName": "apiKey"
}
```

| Field | Rules |
| --- | --- |
| `id` | 2–64 characters: starts with a lower-case letter, then lower-case letters, digits, `_` or `-`. Must equal the `id` of the exported adapter. Built-in ids are reserved; two plugins may not share one. |
| `name` | Display name, 1–120 characters. |
| `version` | Your version string. |
| `entry` | Relative path to an ES module inside the plugin folder. Absolute paths, and paths or symlinks that leave the folder, are rejected. |
| `configSchema` | JSON Schema for the non-secret `config` of a provider binding. |
| `capabilities` | All five keys are required: `tools`, `mcp`, `resume`, `vision` (booleans) and `browser` (`"native"` or `"via_mcp"`). |
| `secretName` | Optional. Name of the secret the adapter expects in `ctx.secrets`, e.g. `"apiKey"`. |

## Entry module

The entry's default export is an adapter object, or a function (sync or async) returning one:

```js
import { defineAdapter, withRun, ActiveRuns, AdapterError } from 'conductor/adapters/sdk';

const active = new ActiveRuns();

export default defineAdapter({
  id: 'my_agent',

  capabilities: () => ({ tools: true, mcp: true, resume: false, vision: false, browser: 'via_mcp' }),

  async testConnection({ config, secrets, model }) {
    return { ok: true, version: '1.0.0', detail: 'ready' };
  },

  run(ctx, onEvent) {
    return withRun(active, ctx, onEvent, { metered: true }, async (env) => {
      env.emit({ type: 'text', text: 'working…' });
      // … call your provider, emit events, add usage to env.meter …
      return env.finish({ outcome: 'completed', steps: 1, finalText: 'done' });
    });
  },

  async cancel(runId) {
    active.cancel(runId);
  },
});
```

`conductor/adapters/sdk` resolves from the plugin folder with no install step: the daemon links itself at `~/.conductor/adapters/node_modules/conductor`. Type definitions ship with it (`import('conductor/adapters/sdk').AgentAdapter`). If your plugin needs other npm packages, install them inside the plugin folder; a real `node_modules/conductor` directory you put there yourself is left alone.

### The contract

```ts
interface AgentAdapter {
  readonly id: string;
  capabilities(): AdapterCapabilities;
  testConnection(cfg: { config: Record<string, unknown>; secrets: Record<string, string>; model?: string | null }): Promise<Health>;
  run(ctx: RunContext, onEvent: (e: RunEvent) => void): Promise<RunResult>;
  cancel(runId: string): Promise<void>;
}
```

`run` receives everything it needs in `ctx`. The fields you will use most:

| Field | Meaning |
| --- | --- |
| `systemPrompt`, `prompt` | The agent's persona, standing memory and rules; and the task for this run. |
| `model`, `config`, `secrets` | From the agent's provider binding. Secrets arrive in memory only: never log them or write them to disk. |
| `mcpEndpoints` | The only way to reach tools. Each entry (`name`, `url`, `headers`) points at Conductor's connector gateway, already authorized for this run. Do not connect to other tool servers. |
| `skills` | Skills resolved for this run: name, description and the absolute path of each skill folder. |
| `workspacePath` | Working directory for the run. |
| `budgetCapUsd`, `maxSteps`, `maxWallMs` | Limits. Stop when one is reached and report the matching outcome. |
| `runToken`, `apiBaseUrl` | Run-scoped bearer token and base URL of the Conductor API. |
| `resumeSessionId`, `priorEvents` | Set when an interrupted run is being resumed and your adapter declares `resume: true`. |
| `sandbox` | The policy the daemon resolved for processes you spawn (`conductorHome`, `network`). |

Report progress through `onEvent` with normalized events: `text`, `thinking`, `tool_call`, `tool_result`, `usage`, `session`, `status`, `error`. Resolve with a `RunResult`: `outcome` (`completed`, `failed`, `cancelled`, `max_steps`, `timeout` or `budget`), `finalText`, `usage`, `steps`, and optionally `sessionId` and `error`.

### What the SDK gives you

| Export | Use |
| --- | --- |
| `defineAdapter` | Type-checks the adapter object. |
| `withRun`, `ActiveRuns`, `RunGuard`, `UsageMeter` | The guard rails the built-in adapters use: cancellation, the wall-clock limit, masking of secret values in everything emitted, usage metering. Prefer `withRun` to writing these yourself. |
| `AdapterError`, `toAdapterError`, `kindFromStatus`, `kindFromMessage`, `isRetryable` | Classify failures as `rate_limit`, `auth`, `outage`, `invalid_request` or `other`. The kind decides whether Conductor tries the agent's fallback provider. |
| `McpToolset`, `runMcpToolLoop` | For adapters that own the model loop: list and call the gateway's tools, and drive a tool-calling loop. |
| `runProcess`, `runJsonLines`, `findExecutable`, `minimalEnv`, `probeCommand` | For adapters that wrap a CLI. |
| `agentSandbox`, `planSandbox`, `buildAgentSandboxProfile`, `sandboxAvailability` | Run a child process under the same macOS sandbox as the built-in CLI adapters. |
| `installClaudeSkills`, `writeAgentsSkills`, `renderAgentsSkillsBlock` | Hand `ctx.skills` to a CLI in the form it expects. |
| `PRICE_TABLE`, `priceFor`, `findPrice` | Turn token counts into cost. |

## Rules and limits

- **Plugins are trusted code.** The daemon loads the entry module into its own process, with your user's privileges; the manifest checks validate its shape, not its behaviour. Install only plugins you have read.
- **Sandbox processes you spawn.** If your adapter starts a CLI, run it through the SDK's sandbox helpers. That sandbox confines file access: by default the child cannot read credential locations such as `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh` or `~/.config/gcloud`, and never Conductor's home. An agent's binding can lift a read denial with `sandbox.allowRead` or add writable paths with `sandbox.allowWrite`. Network policy is only `on` or `local` (loopback): the sandbox cannot filter by hostname.
- **Report cost honestly.** Runs on a flat-rate login should report `costUsd: 0`, `subscription: true` and the seat seconds used; metered runs should report tokens and cost. Budgets and scorecards are computed from what the adapter reports.
- **Keep `run` self-contained.** Do not import daemon internals; only `conductor/adapters/sdk` is a supported import.
