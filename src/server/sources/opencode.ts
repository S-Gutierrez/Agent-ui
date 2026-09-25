// Connects to one or more `opencode serve` HTTP servers and translates their
// sessions and event stream into the office model.
//
// Mapping:
//   * each top-level opencode session       -> one agent
//   * session.status busy|retry / idle      -> working / idle
//   * permission.asked / question.asked     -> needs_review (walks to the boss)
//   * opencode-plugin-peers `send_message`  -> conversation between the two sessions
//   * `task` tool (optional, sub-agents)    -> conversation parent -> child

import type { LogEntry } from "../../shared/types.ts";
import type { OfficeStore } from "../store.ts";
import type { AgentSource, PermissionReply } from "./source.ts";
import { readSse } from "./sse.ts";

export interface OpencodeOptions {
  urls: string[];
  /** Also show sub-agent (child) sessions as office members. */
  includeSubagents?: boolean;
  /** Ignore sessions not updated within this window at startup. */
  maxSessionAgeMs?: number;
  maxAgents?: number;
  /** Optional Authorization header value for the opencode servers. */
  authorization?: string;
  fetch?: typeof fetch;
}

/* Subset of the opencode wire types that we read. */
interface OcSession {
  id: string;
  title?: string;
  slug?: string;
  parentID?: string;
  directory?: string;
  time?: { created?: number; updated?: number };
}
interface OcPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  synthetic?: boolean;
  metadata?: { peerMessage?: { fromEndpointId?: string; toSessionId?: string } } & Record<string, unknown>;
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: Record<string, unknown>; title?: string; metadata?: Record<string, unknown> };
  time?: { start?: number; end?: number };
}
interface OcEvent {
  type: string;
  properties: Record<string, any>;
}

const PEER_HEADER = /^\[peer message from "([^"]+)"[^\]]*?sender endpoint: ([^\]\s;]+)[^\]]*\]/;
const RECENT_SEND_MS = 2 * 60_000;

export class OpencodeSource implements AgentSource {
  readonly name: string;
  private store!: OfficeStore;
  private readonly abort = new AbortController();
  private readonly fetch: typeof fetch;
  /** sessionID -> base url of the server that owns it. */
  private readonly owner = new Map<string, string>();
  private readonly permissionOwner = new Map<string, string>();
  private readonly roleByMessage = new Map<string, "user" | "assistant">();
  private readonly partText = new Map<string, string>();
  private readonly sessions = new Map<string, OcSession>();
  /** Peer bookkeeping: outgoing send_message calls and learned endpoint -> session. */
  private readonly recentSends: Array<{ from: string; to: string; message: string; at: number }> = [];
  private readonly endpointSession = new Map<string, string>();
  private readonly peerNameSession = new Map<string, string>();

  constructor(private readonly opts: OpencodeOptions) {
    this.fetch = opts.fetch ?? fetch;
    this.name = `opencode (${opts.urls.join(", ")})`;
  }

  async start(store: OfficeStore): Promise<void> {
    this.store = store;
    for (const url of this.opts.urls) {
      void this.run(url.replace(/\/+$/, ""));
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
  }

  async sendMessage(agentId: string, text: string): Promise<void> {
    const base = this.owner.get(agentId);
    if (!base) throw new Error("unknown agent");
    await this.call(base, `/session/${encodeURIComponent(agentId)}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    });
  }

  async replyPermission(permissionId: string, reply: PermissionReply): Promise<void> {
    const base = this.permissionOwner.get(permissionId);
    if (!base) throw new Error("unknown permission request");
    await this.call(base, `/permission/${encodeURIComponent(permissionId)}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply }),
    });
  }

  /* ---------------------------------------------------------------- wiring */

  private async run(base: string): Promise<void> {
    let delay = 1_000;
    while (!this.abort.signal.aborted) {
      try {
        await this.bootstrap(base);
        const res = await this.fetch(`${base}/event`, {
          headers: { accept: "text/event-stream", ...this.authHeaders() },
          signal: this.abort.signal,
        });
        if (!res.ok) throw new Error(`GET /event -> ${res.status}`);
        delay = 1_000;
        for await (const data of readSse(res, this.abort.signal)) {
          try {
            this.handle(base, JSON.parse(data) as OcEvent);
          } catch (err) {
            console.warn(`[opencode] bad event from ${base}:`, (err as Error).message);
          }
        }
      } catch (err) {
        if (this.abort.signal.aborted) return;
        console.warn(`[opencode] ${base}: ${(err as Error).message}; retrying in ${delay / 1000}s`);
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  private async bootstrap(base: string): Promise<void> {
    const sessions = await this.call<OcSession[]>(base, "/session");
    const statuses = await this.call<Record<string, { type: string }>>(base, "/session/status").catch(() => ({}) as Record<string, { type: string }>);
    const maxAge = this.opts.maxSessionAgeMs ?? 12 * 3600_000;
    const now = Date.now();
    const chosen = sessions
      .filter((s) => this.opts.includeSubagents || !s.parentID)
      .filter((s) => statuses[s.id]?.type === "busy" || now - (s.time?.updated ?? s.time?.created ?? 0) < maxAge)
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .slice(0, this.opts.maxAgents ?? 16);

    for (const s of chosen) {
      this.addSession(base, s);
      const st = statuses[s.id]?.type;
      this.store.patchAgent(s.id, { status: st === "busy" || st === "retry" ? "working" : "idle" });
    }

    const perms = await this.call<Array<Record<string, any>>>(base, "/permission").catch(() => []);
    for (const p of perms) this.onPermissionAsked(base, p);

    await Promise.all(
      chosen.map(async (s) => {
        const msgs = await this.call<Array<{ info: { id: string; role: "user" | "assistant" }; parts: OcPart[] }>>(
          base,
          `/session/${encodeURIComponent(s.id)}/message?limit=40`,
        ).catch(() => []);
        for (const m of msgs.slice(-40)) {
          this.roleByMessage.set(m.info.id, m.info.role);
          for (const part of m.parts) this.onPart(part, false);
        }
      }),
    );
  }

  private addSession(base: string, s: OcSession): void {
    if (!this.opts.includeSubagents && s.parentID) return;
    const known = this.store.getAgent(s.id);
    if (!known && this.store.listAgents().length >= (this.opts.maxAgents ?? 16)) return;
    this.owner.set(s.id, base);
    this.sessions.set(s.id, s);
    this.store.upsertAgent({
      id: s.id,
      name: s.title?.trim() || s.slug || s.id.slice(-6),
      status: known?.status ?? "idle",
      activity: s.directory,
    });
  }

  private handle(base: string, ev: OcEvent): void {
    const p = ev.properties ?? {};
    switch (ev.type) {
      case "session.created":
      case "session.updated":
        if (p.info) this.addSession(base, p.info as OcSession);
        break;
      case "session.deleted": {
        const id = p.info?.id ?? p.sessionID;
        if (id) {
          this.store.conversations.leave(id);
          this.store.removeAgent(id);
        }
        break;
      }
      case "session.status": {
        const t = p.status?.type;
        this.store.patchAgent(p.sessionID, { status: t === "busy" || t === "retry" ? "working" : "idle" });
        break;
      }
      case "session.idle":
        this.store.patchAgent(p.sessionID, { status: "idle" });
        break;
      case "session.error":
        if (p.sessionID) this.system(p.sessionID, `Error: ${p.error?.data?.message ?? p.error?.name ?? "unknown"}`);
        break;
      case "message.updated":
        if (p.info?.id && p.info?.role) this.roleByMessage.set(p.info.id, p.info.role);
        break;
      case "message.part.updated":
        if (p.part) this.onPart(p.part as OcPart, true);
        break;
      case "message.part.delta":
        this.onDelta(p);
        break;
      case "permission.asked":
        this.onPermissionAsked(base, p);
        break;
      case "permission.replied":
        this.store.removePermission(p.requestID ?? p.permissionID ?? p.id);
        break;
      case "question.asked":
        if (p.id && p.sessionID && this.store.getAgent(p.sessionID)) {
          this.store.addPermission({
            id: p.id,
            agentId: p.sessionID,
            title: questionTitle(p),
            at: Date.now(),
            kind: "question",
          });
        }
        break;
      case "question.replied":
      case "question.rejected":
        this.store.removePermission(p.requestID ?? p.id);
        break;
    }
  }

  private onPermissionAsked(base: string, p: Record<string, any>): void {
    if (!p.id || !p.sessionID || !this.store.getAgent(p.sessionID)) return;
    this.permissionOwner.set(p.id, base);
    const patterns = Array.isArray(p.patterns) ? p.patterns.join(", ") : "";
    this.store.addPermission({
      id: p.id,
      agentId: p.sessionID,
      title: [p.permission ?? p.title ?? "permission", patterns].filter(Boolean).join(": "),
      at: Date.now(),
      kind: "permission",
    });
  }

  private onDelta(p: Record<string, any>): void {
    if (p.field !== "text" || typeof p.delta !== "string") return;
    const prev = this.partText.get(p.partID);
    if (prev === undefined) return; // we only extend parts we have seen
    this.partText.set(p.partID, prev + p.delta);
    const entry = this.lastEntry.get(p.partID);
    if (entry) this.store.log({ ...entry, text: prev + p.delta });
  }

  private readonly lastEntry = new Map<string, LogEntry>();

  private onPart(part: OcPart, live: boolean): void {
    if (!this.store.getAgent(part.sessionID)) return;
    const role = this.roleByMessage.get(part.messageID) ?? "assistant";
    const at = part.time?.start ?? Date.now();
    let entry: LogEntry | undefined;

    if (part.type === "reasoning" && part.text) {
      entry = { id: part.id, agentId: part.sessionID, kind: "reasoning", text: part.text, at };
    } else if (part.type === "text" && part.text) {
      const peer = part.metadata?.peerMessage;
      if (peer) {
        entry = this.onPeerReceived(part, peer, live);
      } else if (!part.synthetic) {
        entry = { id: part.id, agentId: part.sessionID, kind: role === "user" ? "user" : "text", text: part.text, at };
      }
    } else if (part.type === "tool" && part.tool) {
      entry = { id: part.id, agentId: part.sessionID, kind: "tool", text: describeTool(part), at };
      if (live) this.onToolCall(part);
    }

    if (!entry) return;
    this.partText.set(part.id, entry.text);
    this.lastEntry.set(part.id, entry);
    if (this.lastEntry.size > 5_000) {
      const oldest = this.lastEntry.keys().next().value!;
      this.lastEntry.delete(oldest);
      this.partText.delete(oldest);
    }
    this.store.log(entry);
  }

  /** Sender side of opencode-plugin-peers, and sub-agent delegation. */
  private onToolCall(part: OcPart): void {
    const input = part.state?.input ?? {};
    if (part.tool === "send_message" && typeof input.to === "string" && part.state?.status !== "error") {
      const message = typeof input.message === "string" ? input.message : "";
      const already = this.recentSends.some((s) => s.from === part.sessionID && s.message === message && s.to === input.to);
      if (!already) this.recentSends.push({ from: part.sessionID, to: input.to, message, at: Date.now() });
      this.pruneSends();
      const target = this.peerNameSession.get(input.to) ?? this.endpointSession.get(input.to) ?? (this.store.getAgent(input.to) ? input.to : undefined);
      if (target && target !== part.sessionID) this.store.conversations.message(part.sessionID, target);
    }
    if (part.tool === "task" && this.opts.includeSubagents) {
      const child = part.state?.metadata?.sessionId;
      if (typeof child === "string" && this.store.getAgent(child)) this.store.conversations.message(part.sessionID, child);
    }
  }

  /** Receiver side of opencode-plugin-peers: a synthetic user message with peer metadata. */
  private onPeerReceived(part: OcPart, peer: { fromEndpointId?: string }, live: boolean): LogEntry {
    const text = part.text ?? "";
    const header = PEER_HEADER.exec(text);
    const fromName = header?.[1];
    const endpoint = peer.fromEndpointId ?? header?.[2];
    const body = text.replace(PEER_HEADER, "").split(/\n---/)[0]!.trim();

    let from = endpoint ? this.endpointSession.get(endpoint) : undefined;
    if (!from) {
      this.pruneSends();
      const match = [...this.recentSends].reverse().find((s) => s.from !== part.sessionID && s.message && text.includes(s.message));
      from = match?.from;
      if (from && endpoint) this.endpointSession.set(endpoint, from);
      if (from && match) this.peerNameSession.set(match.to, part.sessionID);
    }
    if (from && fromName) this.peerNameSession.set(fromName, from);
    if (live && from && from !== part.sessionID && this.store.getAgent(from)) {
      this.store.conversations.message(from, part.sessionID);
    }
    const label = fromName ?? (from ? this.store.getAgent(from)?.name : undefined) ?? "peer";
    return { id: part.id, agentId: part.sessionID, kind: "peer", text: `<- ${label}: ${body}`, at: Date.now(), peer: from };
  }

  private pruneSends(): void {
    const cutoff = Date.now() - RECENT_SEND_MS;
    while (this.recentSends.length && this.recentSends[0]!.at < cutoff) this.recentSends.shift();
  }

  private system(agentId: string, text: string): void {
    this.store.log({ id: `sys-${Date.now()}-${Math.random().toString(36).slice(2)}`, agentId, kind: "system", text, at: Date.now() });
  }

  private authHeaders(): Record<string, string> {
    return this.opts.authorization ? { authorization: this.opts.authorization } : {};
  }

  private async call<T = unknown>(base: string, path: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetch(`${base}${path}`, {
      ...init,
      headers: { "content-type": "application/json", accept: "application/json", ...this.authHeaders(), ...(init.headers ?? {}) },
      signal: init.signal ?? this.abort.signal,
    });
    if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}`);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

function describeTool(part: OcPart): string {
  const st = part.state ?? {};
  const input = st.input ?? {};
  if (part.tool === "send_message") return `send_message -> ${String(input.to ?? "?")}: ${String(input.message ?? "")}`;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const summary = st.title || str(input.command) || str(input.filePath) || str(input.pattern) || str(input.description);
  return `${part.tool}${summary ? ` ${summary}` : ""} [${st.status ?? "pending"}]`;
}

function questionTitle(p: Record<string, any>): string {
  const q = Array.isArray(p.questions) ? p.questions[0] : undefined;
  return String(q?.question ?? q?.header ?? p.question ?? "Has a question for you");
}
