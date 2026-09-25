import { EventEmitter } from "node:events";
import type { Agent, Conversation, LogEntry, OfficeSnapshot, PermissionRequest, ServerEvent } from "../shared/types.ts";

const MAX_LOG_PER_AGENT = 500;

/**
 * In-memory state of the office. Sources write into it; the HTTP layer reads
 * from it and forwards change events to browsers. Nothing is persisted.
 */
export class OfficeStore extends EventEmitter<{ event: [ServerEvent] }> {
  private agents = new Map<string, Agent>();
  private permissions = new Map<string, PermissionRequest>();
  private logs = new Map<string, LogEntry[]>();
  private snapshotTimer: NodeJS.Timeout | undefined;
  readonly conversations: ConversationTracker;

  constructor(
    readonly sourceName: string,
    conversationTtlMs = 60_000,
  ) {
    super();
    this.conversations = new ConversationTracker(conversationTtlMs, () => this.changed());
  }

  snapshot(): OfficeSnapshot {
    const permissions = [...this.permissions.values()];
    const waiting = new Set(permissions.map((p) => p.agentId));
    return {
      agents: [...this.agents.values()].map((a) => (waiting.has(a.id) ? { ...a, status: "needs_review" } : a)),
      conversations: this.conversations.active(),
      permissions,
      source: this.sourceName,
    };
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  listAgents(): Agent[] {
    return [...this.agents.values()];
  }

  upsertAgent(agent: Agent): void {
    const prev = this.agents.get(agent.id);
    this.agents.set(agent.id, { ...prev, ...agent });
    this.changed();
  }

  patchAgent(id: string, patch: Partial<Agent>): void {
    const prev = this.agents.get(id);
    if (!prev) return;
    this.agents.set(id, { ...prev, ...patch });
    this.changed();
  }

  removeAgent(id: string): void {
    if (!this.agents.delete(id)) return;
    this.logs.delete(id);
    for (const [pid, p] of this.permissions) if (p.agentId === id) this.permissions.delete(pid);
    this.changed();
  }

  addPermission(p: PermissionRequest): void {
    this.permissions.set(p.id, p);
    this.changed();
  }

  getPermission(id: string): PermissionRequest | undefined {
    return this.permissions.get(id);
  }

  removePermission(id: string): void {
    if (this.permissions.delete(id)) this.changed();
  }

  /** Insert or replace (by id) a log entry, e.g. a reasoning part that is still streaming. */
  log(entry: LogEntry): void {
    let list = this.logs.get(entry.agentId);
    if (!list) this.logs.set(entry.agentId, (list = []));
    const i = list.findIndex((e) => e.id === entry.id);
    if (i >= 0) list[i] = entry;
    else {
      list.push(entry);
      if (list.length > MAX_LOG_PER_AGENT) list.splice(0, list.length - MAX_LOG_PER_AGENT);
    }
    this.emit("event", { type: "log", entry });
  }

  history(agentId: string): LogEntry[] {
    return this.logs.get(agentId) ?? [];
  }

  /** Coalesce bursts of changes into one snapshot push. */
  changed(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.emit("event", { type: "snapshot", snapshot: this.snapshot() });
    }, 50);
  }

  dispose(): void {
    clearTimeout(this.snapshotTimer);
    this.conversations.dispose();
  }
}

/**
 * Groups agent-to-agent messages into conversations. A message between two
 * agents joins (and merges) any active conversation either of them is in, so
 * A->B followed by B->C becomes one group {A, B, C}. Conversations end after
 * `ttlMs` without messages.
 */
export class ConversationTracker {
  private convs: Array<Conversation & { lastAt: number }> = [];
  private seq = 0;
  private timer: NodeJS.Timeout;

  constructor(
    private readonly ttlMs: number,
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now,
  ) {
    this.timer = setInterval(() => this.expire(), Math.min(5_000, ttlMs));
    this.timer.unref?.();
  }

  message(from: string, to: string): Conversation {
    const at = this.now();
    this.expire();
    const touching = this.convs.filter((c) => c.participants.includes(from) || c.participants.includes(to));
    let conv: (typeof this.convs)[number];
    if (touching.length === 0) {
      conv = { id: `conv-${++this.seq}-${at.toString(36)}`, participants: [from, to], startedAt: at, lastAt: at };
      this.convs.push(conv);
    } else {
      touching.sort((a, b) => a.startedAt - b.startedAt);
      conv = touching[0]!;
      for (const other of touching.slice(1)) {
        for (const p of other.participants) if (!conv.participants.includes(p)) conv.participants.push(p);
        this.convs = this.convs.filter((c) => c !== other);
      }
      for (const p of [from, to]) if (!conv.participants.includes(p)) conv.participants.push(p);
      conv.lastAt = at;
    }
    this.onChange();
    return conv;
  }

  /** Drop an agent from every conversation (e.g. it left the office). */
  leave(agentId: string): void {
    let changed = false;
    for (const c of this.convs) {
      const i = c.participants.indexOf(agentId);
      if (i >= 0) {
        c.participants.splice(i, 1);
        changed = true;
      }
    }
    this.convs = this.convs.filter((c) => c.participants.length >= 2);
    if (changed) this.onChange();
  }

  active(): Conversation[] {
    return this.convs.map(({ id, participants, startedAt }) => ({ id, participants: [...participants], startedAt }));
  }

  expire(): void {
    const cutoff = this.now() - this.ttlMs;
    const before = this.convs.length;
    this.convs = this.convs.filter((c) => c.lastAt >= cutoff);
    if (this.convs.length !== before) this.onChange();
  }

  dispose(): void {
    clearInterval(this.timer);
  }
}
