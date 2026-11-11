import type { RunEvent } from '../contracts/adapter.js';
import { redact } from '../shared/util.js';

/** One line of the compact transcript handed to the utility model (and parsed by the offline heuristic). */
export interface TranscriptStep {
  kind: 'assistant' | 'tool_call' | 'tool_ok' | 'tool_error' | 'error';
  /** Tool name for tool steps. */
  name?: string;
  text: string;
}

const oneLine = (s: string, max: number): string => {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
};

function compactInput(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function isRunEvent(v: unknown): v is RunEvent {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}

/** Normalised RunEvents → steps (thinking, usage, session and status events carry no lesson and are dropped). */
export function toSteps(events: unknown[]): TranscriptStep[] {
  const steps: TranscriptStep[] = [];
  for (const raw of events) {
    if (!isRunEvent(raw)) continue;
    switch (raw.type) {
      case 'text':
        if (typeof raw.text === 'string' && raw.text.trim()) steps.push({ kind: 'assistant', text: redact(raw.text.trim()) });
        break;
      case 'tool_call':
        steps.push({ kind: 'tool_call', name: String(raw.name), text: redact(oneLine(compactInput(raw.input), 400)) });
        break;
      case 'tool_result':
        steps.push({ kind: raw.isError ? 'tool_error' : 'tool_ok', name: String(raw.name), text: redact(oneLine(String(raw.output ?? ''), 400)) });
        break;
      case 'error':
        steps.push({ kind: 'error', text: redact(oneLine(String(raw.message ?? ''), 400)) });
        break;
      default:
        break;
    }
  }
  return steps;
}

const TAG: Record<TranscriptStep['kind'], string> = {
  assistant: 'assistant',
  tool_call: 'tool_call',
  tool_ok: 'tool_result ok',
  tool_error: 'tool_result error',
  error: 'error',
};

export function renderSteps(steps: TranscriptStep[]): string {
  return steps
    .map((s) => (s.kind === 'assistant' || s.kind === 'error' ? `[${TAG[s.kind]}] ${s.text.replace(/\n+/g, ' ⏎ ')}` : `[${TAG[s.kind]}] ${s.name ?? 'tool'}: ${s.text}`))
    .join('\n');
}

export function parseSteps(rendered: string): TranscriptStep[] {
  const steps: TranscriptStep[] = [];
  for (const line of rendered.split('\n')) {
    const m = /^\[(assistant|tool_call|tool_result ok|tool_result error|error)\] (.*)$/.exec(line);
    if (!m) continue;
    const tag = m[1];
    const rest = m[2] ?? '';
    if (tag === 'assistant') steps.push({ kind: 'assistant', text: rest.replace(/ ⏎ /g, '\n') });
    else if (tag === 'error') steps.push({ kind: 'error', text: rest });
    else {
      const idx = rest.indexOf(': ');
      const name = idx >= 0 ? rest.slice(0, idx) : rest;
      const text = idx >= 0 ? rest.slice(idx + 2) : '';
      steps.push({ kind: tag === 'tool_call' ? 'tool_call' : tag === 'tool_result ok' ? 'tool_ok' : 'tool_error', name, text });
    }
  }
  return steps;
}

/**
 * Fit a rendered transcript into a character budget by keeping the head and
 * the tail (where the resolution usually is) and saying what was cut.
 */
export function fitTranscript(rendered: string, maxChars = 48_000): string {
  if (rendered.length <= maxChars) return rendered;
  const lines = rendered.split('\n');
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  let lo = 0;
  let hi = lines.length - 1;
  while (lo <= hi) {
    const takeTail = tail.length * 2 < head.length * 3; // ~60% of the budget to the tail
    const line = (takeTail ? lines[hi] : lines[lo]) ?? '';
    if (used + line.length + 1 > maxChars) break;
    used += line.length + 1;
    if (takeTail) {
      tail.unshift(line);
      hi--;
    } else {
      head.push(line);
      lo++;
    }
  }
  const omitted = hi - lo + 1;
  return [...head, `[omitted ${omitted} transcript lines to fit the context budget]`, ...tail].join('\n');
}

/** Tool calls that ended in a successful result, in order — the raw material of a procedure. */
export function successfulSteps(steps: TranscriptStep[]): Array<{ name: string; input: string }> {
  const out: Array<{ name: string; input: string }> = [];
  let pending: { name: string; input: string } | null = null;
  for (const s of steps) {
    if (s.kind === 'tool_call') pending = { name: s.name ?? 'tool', input: s.text };
    else if (s.kind === 'tool_ok' && pending && pending.name === s.name) {
      out.push(pending);
      pending = null;
    } else if (s.kind === 'tool_error') pending = null;
  }
  return out;
}

export function tag(name: string, body: string): string {
  return `<${name}>\n${body}\n</${name}>`;
}

export function readTag(prompt: string, name: string): string | null {
  const m = new RegExp(`<${name}>\\n?([\\s\\S]*?)\\n?</${name}>`).exec(prompt);
  return m?.[1] ?? null;
}
