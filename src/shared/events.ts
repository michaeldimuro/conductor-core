/**
 * In-process domain event bus. Bounded contexts publish facts here; the
 * scheduler (wake triggers), WebSocket fan-out, outbound webhooks and
 * messaging gateways subscribe. Handlers never throw into the publisher.
 */
export interface DomainEvents {
  'org.created': { orgId: string };
  'org.updated': { orgId: string };
  'org.kill_switch': { orgId: string | null; engaged: boolean };
  /** The org was archived: its in-flight runs are cancelled and nothing more is scheduled for it. */
  'org.archived': { orgId: string };
  'org.unarchived': { orgId: string };
  'agent.hired': { orgId: string; agentId: string };
  'agent.updated': { orgId: string; agentId: string };
  'agent.paused': { orgId: string; agentId: string; reason: string };
  'agent.resumed': { orgId: string; agentId: string };
  'goal.created': { orgId: string; goalId: string };
  'goal.updated': { orgId: string; goalId: string };
  'goal.deleted': { orgId: string; goalId: string };
  'project.updated': { orgId: string; projectId: string };
  'playbook.changed': { orgId: string; playbookId: string; change: 'updated' | 'deleted' | 'restored' };
  'issue.created': { orgId: string; issueId: string; assigneeAgentId: string | null };
  'issue.assigned': { orgId: string; issueId: string; agentId: string };
  'issue.updated': { orgId: string; issueId: string; status: string };
  'issue.done': { orgId: string; issueId: string };
  /** A reviewer's verdict on an in_review issue (feeds run grading, scorecards and skill adaptation). */
  'issue.reviewed': { orgId: string; issueId: string; outcome: 'accepted' | 'edited' | 'rejected' };
  'comment.created': { orgId: string; issueId: string; commentId: string; mentions: string[] };
  'approval.requested': { orgId: string; approvalId: string; kind: string };
  'approval.decided': { orgId: string; approvalId: string; status: 'approved' | 'denied'; requesterAgentId: string | null };
  'run.started': { orgId: string; runId: string; agentId: string; issueId: string | null };
  'run.event': { orgId: string; runId: string; seq: number; event: unknown };
  'run.paused': { orgId: string; runId: string; reason: string };
  'run.resumed': { orgId: string; runId: string };
  'run.finished': { orgId: string; runId: string; agentId: string; issueId: string | null; outcome: string };
  /** A wake produced no run. `deferredUntil` is set when the wake was kept and will be retried. */
  'run.skipped': { orgId: string; agentId: string; jobId: string | null; trigger: string; code: string; reason: string; deferredUntil: number | null };
  'budget.alert': { orgId: string; level: 'soft' | 'hard'; scope: string; scopeId: string; pct: number };
  /** A budget cap was created, raised, lowered or removed (budget-paused agents may be resumable). */
  'budget.updated': { orgId: string; scope: string; scopeId: string };
  'skill.changed': { orgId: string | null; skillId: string; status: string };
  'memory.written': { orgId: string; memoryId: string };
  'browser.human_requested': { orgId: string; runId: string; sessionId: string; reason: string };
  'browser.handed_back': { orgId: string; runId: string; sessionId: string };
  'webhook.received': { orgId: string; webhookId: string; agentId: string | null; payload: unknown };
  'manual.run_now': { orgId: string; agentId: string; issueId: string | null };
  'notification': { orgId: string | null; kind: string; title: string; body: string; link?: string; actions?: NotificationAction[]; data?: Record<string, unknown> };
}

export interface NotificationAction {
  label: string;
  /** e.g. "approval:approve:<id>" — interpreted by gateways and the UI. */
  action: string;
}

export type EventName = keyof DomainEvents;
export type Handler<K extends EventName> = (payload: DomainEvents[K]) => void | Promise<void>;
export type AnyHandler = (name: EventName, payload: DomainEvents[EventName]) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<EventName, Set<Handler<EventName>>>();
  private anyHandlers = new Set<AnyHandler>();
  onError: (err: unknown, name: EventName) => void = () => {};

  on<K extends EventName>(name: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler as Handler<EventName>);
    return () => set.delete(handler as Handler<EventName>);
  }

  onAny(handler: AnyHandler): () => void {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  emit<K extends EventName>(name: K, payload: DomainEvents[K]): void {
    const run = (fn: () => void | Promise<void>) => {
      try {
        const r = fn();
        if (r && typeof (r as Promise<void>).catch === 'function') {
          (r as Promise<void>).catch((e) => this.onError(e, name));
        }
      } catch (e) {
        this.onError(e, name);
      }
    };
    for (const h of this.handlers.get(name) ?? []) run(() => h(payload));
    for (const h of this.anyHandlers) run(() => h(name, payload));
  }

  /** Resolve on the next matching event (or reject on timeout). */
  once<K extends EventName>(
    name: K,
    predicate: (p: DomainEvents[K]) => boolean = () => true,
    timeoutMs?: number,
  ): Promise<DomainEvents[K]> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | undefined;
      const off = this.on(name, (p) => {
        if (!predicate(p)) return;
        off();
        if (timer) clearTimeout(timer);
        resolve(p);
      });
      if (timeoutMs !== undefined) {
        timer = setTimeout(() => {
          off();
          reject(new Error(`timeout waiting for ${name}`));
        }, timeoutMs);
        timer.unref?.();
      }
    });
  }
}
