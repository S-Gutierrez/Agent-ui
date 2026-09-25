// Connects to opencode HTTP servers and translates their sessions and event
// stream into the office model. Servers come from OPENCODE_URLS and/or are
// discovered automatically from the opencode-plugin-peers registry.
//
// Mapping:
//   * each top-level opencode session       -> one agent (named after its opencode agent)
//   * session.status busy|retry / idle      -> working / idle
//   * permission.asked / question.asked     -> needs_review (walks to the boss)
//   * opencode-plugin-peers `send_message`  -> conversation between the two sessions
//   * `task` tool (optional, sub-agents)    -> conversation parent -> child

import type { LogEntry } from "../../shared/types.ts";
import type { OfficeStore } from "../store.ts";
import { agentDefinitions, BUILTIN_AGENTS, findRepoRoot, PEER_NAME_RE } from "../project.ts";
import { readPeers, type PeerEndpoint } from "./peers-registry.ts";
import type { AgentSource, PermissionReply } from "./source.ts";
import { readSse } from "./sse.ts";

export interface OpencodeOptions {
  urls: string[];
  /** opencode-plugin-peers registry directory; when set, running peers are discovered automatically. */
  peersDir?: string;
  peersPollMs?: number;
  /** Also show sub-agent (child) sessions as office members. */
  includeSubagents?: boolean;
  /** Ignore sessions not updated within this window at startup (explicit URLs only). */
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
  agent?: string;
  time?: { created?: number; updated?: number; archived?: number };
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
interface Server {
  abort: AbortController;
  /** Found through the peers registry (as opposed to OPENCODE_URLS). */
  discovered: boolean;
  missingSince?: number;
}

const PEER_HEADER = /^\[peer message from "([^"]+)"[^\]]*?sender endpoint: ([^\]\s;]+)[^\]]*\]/;
const RECENT_SEND_MS = 2 * 60_000;
const SERVER_GONE_MS = 60_000;

export class OpencodeSource implements AgentSource {
  readonly name: string;
  private store!: OfficeStore;
  private readonly abort = new AbortController();
  private readonly fetch: typeof fetch;
  private readonly servers = new Map<string, Server>();
  private pollTimer: NodeJS.Timeout | undefined;
  /** sessionID -> base url of the server that owns it. */
  private readonly owner = new Map<string, string>();
  private readonly permissionOwner = new Map<string, string>();
  private readonly roleByMessage = new Map<string, "user" | "assistant">();
  private readonly partText = new Map<string, string>();
  private readonly sessions = new Map<string, OcSession>();
  /** sessionID -> opencode agent name (from the session or its latest message). */
  private readonly agentOf = new Map<string, string>();
  /** Live peers from the registry, by session id. */
  private readonly registered = new Map<string, PeerEndpoint>();
  private readonly warnedAllow = new Set<string>();
  /** Peer bookkeeping: outgoing send_message calls and learned endpoint -> session. */
  private readonly recentSends: Array<{ from: string; to: string; message: string; at: number }> = [];
  private readonly endpointSession = new Map<string, string>();
  private readonly peerNameSession = new Map<string, string>();

  constructor(private readonly opts: OpencodeOptions) {
    this.fetch = opts.fetch ?? fetch;
    const parts = [...opts.urls];
    if (opts.peersDir) parts.push("peers auto-discovery");
    this.name = `opencode (${parts.join(", ")})`;
  }

  async start(store: OfficeStore): Promise<void> {
    this.store = store;
    for (const url of this.opts.urls) this.connect(url.replace(/\/+$/, ""), false);
    if (this.opts.peersDir) {
      await this.pollPeers();
      this.pollTimer = setInterval(() => void this.pollPeers(), this.opts.peersPollMs ?? 5_000);
      this.pollTimer.unref?.();
    }
    this.updateEmptyWarning();
  }

  async stop(): Promise<void> {
    clearInterval(this.pollTimer);
    this.abort.abort();
    for (const s of this.servers.values()) s.abort.abort();
  }

  async sendMessage(agentId: string, text: string): Promise<void> {
    const base = this.owner.get(agentId);
    if (!base) throw new Error("unknown agent");
    await this.call(base, `/session/${encodeURIComponent(agentId)}/prompt_async`, {
      method: "POST",
      body: JSON.stringify({ parts: [{ type: "text", text }] }),
    });
  }

  async replyPermission(permissionId: string, reply: PermissionReply, message?: string): Promise<void> {
    const base = this.permissionOwner.get(permissionId);
    if (!base) throw new Error("unknown permission request");
    await this.call(base, `/permission/${encodeURIComponent(permissionId)}/reply`, {
      method: "POST",
      body: JSON.stringify(message ? { reply, message } : { reply }),
    });
  }

  /* ------------------------------------------------------------- discovery */

  private async pollPeers(): Promise<void> {
    const peers = await readPeers(this.opts.peersDir!);
    const now = Date.now();
    const liveUrls = new Set<string>();
    this.registered.clear();
    for (const p of peers) {
      liveUrls.add(p.serverUrl);
      if (p.sessionId) this.registered.set(p.sessionId, p);
      if (p.endpointId && p.sessionId) this.endpointSession.set(p.endpointId, p.sessionId);
      if (p.name && p.sessionId) this.peerNameSession.set(p.name, p.sessionId);
      const key = p.endpointId ?? p.sessionId ?? p.serverUrl;
      if (p.peerPermissions === "allow" && !this.warnedAllow.has(key)) {
        this.warnedAllow.add(key);
        console.warn(`[peers] ${p.name ?? key} runs with peerPermissions "allow": peer-triggered actions skip the boss desk.`);
      }
    }
    const unsafe = peers.filter((p) => p.peerPermissions === "allow").map((p) => p.name ?? p.sessionId ?? "?");
    this.store.setWarning(
      "peer-allow",
      unsafe.length
        ? `Peers plugin auto-approves peer-triggered actions for: ${[...new Set(unsafe)].join(", ")}. Set "peerPermissions": "ask" in their opencode.json so everything reaches your desk.`
        : undefined,
    );

    for (const url of liveUrls) {
      const known = this.servers.get(url);
      if (known) known.missingSince = undefined;
      else this.connect(url, true);
    }
    for (const [url, server] of this.servers) {
      if (!server.discovered || liveUrls.has(url)) continue;
      server.missingSince ??= now;
      if (now - server.missingSince > SERVER_GONE_MS) this.dropServer(url);
    }
    // Sessions that registered after we connected to their server.
    for (const [sessionId, peer] of this.registered) {
      if (!this.store.getAgent(sessionId) && this.servers.has(peer.serverUrl)) {
        void this.call<OcSession>(peer.serverUrl, `/session/${encodeURIComponent(sessionId)}`)
          .then((s) => s && this.addSession(peer.serverUrl, s))
          .catch(() => {});
      }
    }
    for (const id of this.owner.keys()) this.refreshName(id);
    this.checkNaming();
    this.updateEmptyWarning();
  }

  private connect(base: string, discovered: boolean): void {
    if (this.servers.has(base)) return;
    const abort = new AbortController();
    this.abort.signal.addEventListener("abort", () => abort.abort(), { once: true });
    this.servers.set(base, { abort, discovered });
    void this.run(base, abort.signal);
  }

  private dropServer(base: string): void {
    this.servers.get(base)?.abort.abort();
    this.servers.delete(base);
    for (const [id, owner] of [...this.owner]) {
      if (owner !== base) continue;
      this.owner.delete(id);
      this.store.conversations.leave(id);
      this.store.removeAgent(id);
    }
    this.updateEmptyWarning();
  }

  private updateEmptyWarning(): void {
    const empty = this.store.listAgents().length === 0;
    this.store.setWarning(
      "no-agents",
      empty
        ? this.opts.peersDir
          ? "No agents yet. Start opencode (with the peers plugin) in your project, or set OPENCODE_URLS."
          : "No agents yet. Check that the opencode servers in OPENCODE_URLS are running."
        : undefined,
    );
  }

  /* ---------------------------------------------------------------- wiring */

  private async run(base: string, signal: AbortSignal): Promise<void> {
    let delay = 1_000;
    while (!signal.aborted) {
      try {
        await this.bootstrap(base);
        const res = await this.fetch(`${base}/event`, {
          headers: { accept: "text/event-stream", ...this.authHeaders() },
          signal,
        });
        if (!res.ok) throw new Error(`GET /event -> ${res.status}`);
        delay = 1_000;
        for await (const data of readSse(res, signal)) {
          try {
            this.handle(base, JSON.parse(data) as OcEvent);
          } catch (err) {
            console.warn(`[opencode] bad event from ${base}:`, (err as Error).message);
          }
        }
      } catch (err) {
        if (signal.aborted) return;
        console.warn(`[opencode] ${base}: ${(err as Error).message}; retrying in ${delay / 1000}s`);
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 30_000);
    }
  }

  /** Should this session be an office member? */
  private wanted(base: string, s: OcSession): boolean {
    if (s.time?.archived) return false;
    if (s.parentID && !this.opts.includeSubagents) return false;
    if (this.servers.get(base)?.discovered) {
      // Discovered servers: only the sessions that are live peers (plus their sub-agents).
      return this.registered.has(s.id) || (!!s.parentID && this.registered.has(s.parentID));
    }
    return true;
  }

  private async bootstrap(base: string): Promise<void> {
    const sessions = (await this.call<OcSession[]>(base, "/session")) ?? [];
    const statuses =
      (await this.call<Record<string, { type: string }>>(base, "/session/status").catch(() => undefined)) ?? ({} as Record<string, { type: string }>);
    const maxAge = this.opts.maxSessionAgeMs ?? 12 * 3600_000;
    const now = Date.now();
    const discovered = this.servers.get(base)?.discovered;
    const chosen = sessions
      .filter((s) => this.wanted(base, s))
      .filter((s) => discovered || statuses[s.id]?.type === "busy" || now - (s.time?.updated ?? s.time?.created ?? 0) < maxAge)
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
        const msgs = await this.call<Array<{ info: { id: string; role: "user" | "assistant"; agent?: string }; parts: OcPart[] }>>(
          base,
          `/session/${encodeURIComponent(s.id)}/message?limit=40`,
        ).catch(() => []);
        for (const m of msgs.slice(-40)) {
          this.roleByMessage.set(m.info.id, m.info.role);
          if (m.info.agent) this.learnAgent(s.id, m.info.agent);
          for (const part of m.parts) this.onPart(part, false);
        }
      }),
    );
    this.updateEmptyWarning();
  }

  private addSession(base: string, s: OcSession): void {
    if (!this.wanted(base, s)) {
      // An archived or no-longer-wanted session leaves the office.
      if (this.store.getAgent(s.id) && s.time?.archived) this.store.removeAgent(s.id);
      return;
    }
    const known = this.store.getAgent(s.id);
    if (!known && this.store.listAgents().length >= (this.opts.maxAgents ?? 16)) return;
    this.owner.set(s.id, base);
    this.sessions.set(s.id, s);
    if (s.agent) this.agentOf.set(s.id, s.agent);
    this.store.upsertAgent({
      id: s.id,
      name: known?.name ?? this.baseName(s.id),
      status: known?.status ?? "idle",
      activity: s.title,
      agentName: this.agentOf.get(s.id),
      directory: s.directory ?? this.registered.get(s.id)?.directory,
    });
    this.refreshName(s.id);
    this.checkNaming();
    this.updateEmptyWarning();
  }

  private learnAgent(sessionId: string, agent: string): void {
    if (this.agentOf.get(sessionId) === agent) return;
    this.agentOf.set(sessionId, agent);
    if (this.store.getAgent(sessionId)) {
      this.store.patchAgent(sessionId, { agentName: agent });
      this.refreshName(sessionId);
      this.checkNaming();
    }
  }

  /** Agent name first (that's how the boss knows them), then peer name, then session title. */
  private baseName(id: string): string {
    const s = this.sessions.get(id);
    return this.agentOf.get(id) ?? this.registered.get(id)?.name ?? (s?.title?.trim() || s?.slug || id.slice(-6));
  }

  /** Keep names unique: two sessions of the same agent become "reviewer (backend)" and "reviewer (web)". */
  private refreshName(id: string): void {
    const agents = this.store.listAgents();
    const base = this.baseName(id);
    const clashes = agents.filter((a) => a.id !== id && this.baseName(a.id) === base);
    const qualify = (sid: string) => {
      const extra = this.registered.get(sid)?.name ?? this.sessions.get(sid)?.title?.trim() ?? sid.slice(-6);
      return extra && extra !== base ? `${base} (${extra})` : `${base} (${sid.slice(-4)})`;
    };
    const name = clashes.length ? qualify(id) : base;
    if (this.store.getAgent(id)?.name !== name) this.store.patchAgent(id, { name });
    for (const other of clashes) {
      const n = qualify(other.id);
      if (other.name !== n) this.store.patchAgent(other.id, { name: n });
    }
    this.enrich(id);
  }

  /** Peer name and agent description (from `<repo>/.opencode/agents/<agent>.md`). */
  private enrich(id: string): void {
    const agent = this.store.getAgent(id);
    if (!agent) return;
    const peerName = this.registered.get(id)?.name;
    const agentName = this.agentOf.get(id);
    const dir = agent.directory;
    const description = agentName && dir ? agentDefinitions(findRepoRoot(dir)).get(agentName)?.description : undefined;
    if (agent.peerName !== peerName || agent.description !== description) this.store.patchAgent(id, { peerName, description });
  }

  /**
   * Every agent should be a custom agent from `.opencode/agents/` and use that
   * same name as its peer name, so "send_message to reviewer" reaches the
   * reviewer and its memory file is found.
   */
  private checkNaming(): void {
    const mismatched: string[] = [];
    const builtin: string[] = [];
    const undefinedAgents: string[] = [];
    for (const a of this.store.listAgents()) {
      const agentName = this.agentOf.get(a.id);
      if (!agentName) continue;
      if (BUILTIN_AGENTS.has(agentName)) builtin.push(a.name);
      else if (a.directory && !agentDefinitions(findRepoRoot(a.directory)).has(agentName)) undefinedAgents.push(agentName);
      if (a.peerName && a.peerName !== agentName) mismatched.push(`"${a.peerName}" runs agent "${agentName}"`);
    }
    this.store.setWarning(
      "peer-name",
      mismatched.length
        ? `Peer name should equal the agent name: ${mismatched.join("; ")}. Click the agent and use "rename peer", or start it with npm run agent.`
        : undefined,
    );
    this.store.setWarning(
      "builtin-agent",
      builtin.length ? `Using a built-in agent instead of one from .opencode/agents/: ${builtin.join(", ")}. Start it with opencode --agent <name>.` : undefined,
    );
    this.store.setWarning(
      "unknown-agent",
      undefinedAgents.length ? `No .opencode/agents/<name>.md found for: ${[...new Set(undefinedAgents)].join(", ")}.` : undefined,
    );
  }

  /** Runs `/peers-name <agent>` in the agent's session so its peer name matches the agent name. */
  async fixPeerName(agentId: string): Promise<string> {
    const base = this.owner.get(agentId);
    const agentName = this.agentOf.get(agentId);
    if (!base || !agentName) throw new Error("unknown agent or agent name");
    if (!PEER_NAME_RE.test(agentName)) throw new Error(`"${agentName}" is not a valid peer name (1-32 letters, digits, space, _ or -)`);
    await this.call(base, `/session/${encodeURIComponent(agentId)}/command`, {
      method: "POST",
      body: JSON.stringify({ command: "peers-name", arguments: agentName }),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(15_000)]),
    });
    await this.pollPeers().catch(() => {});
    return agentName;
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
        {
          const sid = p.info?.sessionID ?? p.sessionID;
          if (sid && typeof p.info?.agent === "string") this.learnAgent(sid, p.info.agent);
        }
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
    const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    const patterns = strings(p.patterns);
    const permission = String(p.permission ?? p.type ?? "permission");
    this.store.addPermission({
      id: p.id,
      agentId: p.sessionID,
      title: [permission, patterns.join(", ") || p.title].filter(Boolean).join(": "),
      at: Date.now(),
      kind: "permission",
      permission,
      patterns,
      always: strings(p.always),
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
