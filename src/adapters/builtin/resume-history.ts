import type { RunContext, RunEvent } from '../../contracts/adapter.js';
import type { McpTool } from '../shared/mcp-tools.js';

/** Session id the API adapters report: their transcript lives in Conductor's run journal, not at the provider. */
export const CONDUCTOR_SESSION_PREFIX = 'conductor-run:';
export const conductorSessionId = (runId: string): string => `${CONDUCTOR_SESSION_PREFIX}${runId}`;

export const RESUME_PREAMBLE =
  'You are resuming a run that was interrupted (for example by a restart). The messages that follow are the journaled ' +
  'transcript of that run: what you said and every tool call with its result (private reasoning is not kept). ' +
  'Do not repeat work that already succeeded. The task is restated at the end.';

const INTERRUPTED =
  'No result was recorded: the run was interrupted before this tool returned. Its effects are unknown — check before repeating it.';

export interface ResumeCall {
  id: string;
  /** Provider-safe tool name. */
  name: string;
  input: Record<string, unknown>;
  output: string;
  isError: boolean;
}

/** One model turn of the interrupted run: what it said, then the tools it called (each with a result). */
export interface ResumeTurn {
  text: string;
  calls: ResumeCall[];
}

export interface ResumeHistory {
  turns: ResumeTurn[];
  /** Oldest turns left out to stay within the size cap. */
  dropped: number;
}

const safeName = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'tool';
const sizeOf = (t: ResumeTurn): number => t.text.length + t.calls.reduce((n, c) => n + c.output.length + JSON.stringify(c.input).length + 64, 0);

/**
 * Rebuild the turns of an interrupted run from its journaled RunEvents.
 * The tool loop emits, per model request: [thinking] [text] usage, then
 * tool_call/tool_result pairs — so a `usage` (or text) after a completed
 * request starts the next turn. Calls left without a result (the crash
 * point) get a synthetic "interrupted" error result so the history is valid.
 */
export function buildResumeHistory(events: RunEvent[], tools: McpTool[] = [], maxChars = 300_000): ResumeHistory {
  const nameOf = new Map(tools.map((t) => [t.originalName, t.name]));
  const turns: ResumeTurn[] = [];
  let current: ResumeTurn & { sawUsage: boolean } = { text: '', calls: [], sawUsage: false };
  const close = (): void => {
    if (current.text || current.calls.length > 0) turns.push({ text: current.text, calls: current.calls });
    current = { text: '', calls: [], sawUsage: false };
  };

  for (const e of events) {
    switch (e.type) {
      case 'thinking':
      case 'text':
        if (current.sawUsage || current.calls.length > 0) close();
        if (e.type === 'text') current.text += (current.text ? '\n' : '') + e.text;
        break;
      case 'usage':
        if (current.sawUsage) close();
        current.sawUsage = true;
        break;
      case 'tool_call': {
        const input = e.input !== null && typeof e.input === 'object' && !Array.isArray(e.input) ? (e.input as Record<string, unknown>) : {};
        current.calls.push({ id: e.id, name: nameOf.get(e.name) ?? safeName(e.name), input, output: INTERRUPTED, isError: true });
        break;
      }
      case 'tool_result': {
        const call = current.calls.find((c) => c.id === e.id);
        if (call) {
          call.output = e.output || '(no output)';
          call.isError = e.isError;
        }
        break;
      }
      default:
        break;
    }
  }
  close();

  // Keep the most recent turns that fit; the model needs the latest state, not the whole past.
  let total = 0;
  let keepFrom = turns.length;
  while (keepFrom > 0) {
    const size = sizeOf(turns[keepFrom - 1] as ResumeTurn);
    if (total + size > maxChars && keepFrom < turns.length) break;
    total += size;
    keepFrom--;
  }
  return { turns: turns.slice(keepFrom), dropped: keepFrom };
}

/** History for a resumed run, or null when this is a fresh run / the runtime supplied no transcript. */
export function resumeHistoryOf(ctx: Pick<RunContext, 'resumeSessionId' | 'priorEvents'>, tools: McpTool[]): ResumeHistory | null {
  if (!ctx.resumeSessionId || !ctx.priorEvents || ctx.priorEvents.length === 0) return null;
  const history = buildResumeHistory(ctx.priorEvents, tools);
  return history.turns.length > 0 ? history : null;
}

export const resumePreamble = (h: ResumeHistory): string => (h.dropped > 0 ? `${RESUME_PREAMBLE} (The ${h.dropped} oldest turn(s) were left out for length.)` : RESUME_PREAMBLE);
