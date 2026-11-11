// Example third-party adapter for Conductor.
//
// Install: copy this folder to ~/.conductor/adapters/echo-adapter/ — the
// daemon picks it up without a restart (or run `conductor adapter rescan`).
// Nothing in Conductor's core changes.
//
// The SDK import below resolves from the plugin folder with no install step:
// Conductor links itself at ~/.conductor/adapters/node_modules/conductor.
import { AdapterError, defineAdapter, withRun, ActiveRuns } from 'conductor/adapters/sdk';

const active = new ActiveRuns();

/** @type {import('conductor/adapters/sdk').AgentAdapter} */
const adapter = defineAdapter({
  id: 'example_echo',

  capabilities: () => ({ tools: false, mcp: false, resume: false, vision: false, browser: 'via_mcp' }),

  async testConnection({ config }) {
    if (config.prefix !== undefined && typeof config.prefix !== 'string') return { ok: false, detail: 'config.prefix must be a string' };
    return { ok: true, version: '1.0.0', detail: 'echo adapter ready' };
  },

  // `withRun` gives a plugin the same guard rails as the built-ins: cancel,
  // wall-clock limit, secret masking in everything emitted, usage metering.
  run(ctx, onEvent) {
    return withRun(active, ctx, onEvent, { metered: false }, async (env) => {
      if (!ctx.prompt.trim()) return env.fail(new AdapterError('invalid_request', 'nothing to echo: the prompt is empty'), 0);
      const prefix = typeof ctx.config.prefix === 'string' ? ctx.config.prefix : '';
      const body = ctx.config.uppercase === true ? ctx.prompt.toUpperCase() : ctx.prompt;
      const text = `${prefix}${body}`;
      env.emit({ type: 'status', status: 'echoing the prompt' });
      env.emit({ type: 'text', text });
      env.meter.addReported(Math.ceil(ctx.prompt.length / 4), Math.ceil(text.length / 4), 0);
      return env.finish({ outcome: 'completed', steps: 1, finalText: text });
    });
  },

  async cancel(runId) {
    active.cancel(runId);
  },
});

export default adapter;
