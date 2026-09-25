// A self-running simulation so the office can be tried without opencode.
// Everything it produces is fake and labelled as such.

import type { AgentStatus } from "../../shared/types.ts";
import type { OfficeStore } from "../store.ts";
import type { AgentSource, PermissionReply } from "./source.ts";

const CAST = [
  { id: "ada", name: "Ada", role: "backend" },
  { id: "linus", name: "Linus", role: "infra" },
  { id: "grace", name: "Grace", role: "compiler" },
  { id: "alan", name: "Alan", role: "research" },
  { id: "margaret", name: "Margaret", role: "QA" },
  { id: "ken", name: "Ken", role: "frontend" },
];

const THOUGHTS = [
  "Reading the failing test to understand the expected behaviour.",
  "The stack trace points at the session cache; checking how entries are invalidated.",
  "Hypothesis: the race happens when two writers flush at the same time.",
  "Let me grep for other callers before changing the signature.",
  "Running the unit tests for this package only.",
  "Two tests fail, both about timezone handling. Looking at the fixture dates.",
  "Refactoring the parser into smaller functions so each case is testable.",
  "The migration needs to be reversible; writing the down step first.",
  "Checking the bundle size impact of this dependency.",
  "Drafting a summary of the change for the reviewer.",
];

const TOOLS = ["read src/cache.ts", "grep 'flush('", "bash npm test -- cache", "edit src/parser.ts", "glob **/*.sql"];

const PEER_LINES = [
  "Hey, are you touching the auth middleware? I need to change its signature.",
  "Can you review my approach for the retry logic before I continue?",
  "I found a bug in the shared date helper, heads up.",
  "Which fixture should I use for the integration tests?",
];

/** Simulated requests: what is asked, the simplified "always" pattern, and a narrower retry. */
const REQUESTS = [
  { permission: "bash", patterns: ["npm publish --dry-run"], always: ["npm *"], narrower: ["npm publish --dry-run"] },
  { permission: "bash", patterns: ["rm -rf dist/"], always: ["rm *"], narrower: ["rm -rf dist/"] },
  { permission: "bash", patterns: ["git push origin feature/login"], always: ["git *"], narrower: ["git push origin feature/*"] },
  { permission: "edit", patterns: [".github/workflows/ci.yml"], always: ["*"], narrower: [".github/workflows/ci.yml"] },
  { permission: "webfetch", patterns: ["https://api.example.com/v1/users"], always: ["*"], narrower: ["https://api.example.com/v1/*"] },
];

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

export class MockSource implements AgentSource {
  readonly name = "simulation";
  private store!: OfficeStore;
  private timers: NodeJS.Timeout[] = [];
  private seq = 0;
  private pendingPermission = new Map<string, { agentId: string; req: (typeof REQUESTS)[number]; retried: boolean }>();

  async start(store: OfficeStore): Promise<void> {
    this.store = store;
    for (const c of CAST) {
      store.upsertAgent({ id: c.id, name: c.name, status: Math.random() < 0.6 ? "working" : "idle", activity: c.role });
      this.log(c.id, "system", `(simulated agent) ${c.name} joined the office - role: ${c.role}.`);
    }
    this.every(2_500, () => this.think());
    this.every(7_000, () => this.shuffleStatus());
    this.every(11_000, () => this.peerChat());
    this.every(19_000, () => this.askPermission());
  }

  async sendMessage(agentId: string, text: string): Promise<void> {
    const agent = this.store.getAgent(agentId);
    if (!agent) throw new Error("unknown agent");
    this.log(agentId, "user", text);
    this.store.patchAgent(agentId, { status: "working", activity: "answering the boss" });
    this.later(1_200, () => this.log(agentId, "reasoning", `The boss asked: "${text.slice(0, 120)}". Thinking about how to respond.`));
    this.later(2_600, () =>
      this.log(agentId, "text", `(simulated reply) Got it, I'll take "${text.slice(0, 60)}" into account. This is a demo agent - connect opencode for real answers.`),
    );
  }

  async replyPermission(permissionId: string, reply: PermissionReply, message?: string): Promise<void> {
    const pending = this.pendingPermission.get(permissionId);
    if (!pending) throw new Error("unknown permission request");
    const { agentId, req, retried } = pending;
    this.pendingPermission.delete(permissionId);
    this.store.removePermission(permissionId);
    this.store.patchAgent(agentId, { status: "working" });
    if (reply === "once") {
      this.log(agentId, "tool", `${req.permission} ${req.patterns.join(" ")} [completed]`);
      return;
    }
    if (message) this.log(agentId, "reasoning", `Permission rejected: "${message}"`);
    if (!retried && message && /narrower|outside that scope/i.test(message)) {
      // Behave like a well-mannered agent: ask again with a tighter request.
      this.later(4_000, () => this.request(agentId, { ...req, patterns: req.narrower, always: req.narrower }, true));
    } else {
      this.log(agentId, "reasoning", "Okay, I'll find another way to do this without that permission.");
    }
  }

  async stop(): Promise<void> {
    this.timers.forEach(clearInterval);
  }

  private think(): void {
    for (const a of this.store.listAgents()) {
      if (a.status !== "working" || Math.random() < 0.4) continue;
      if (Math.random() < 0.3) this.log(a.id, "tool", pick(TOOLS));
      else this.log(a.id, "reasoning", pick(THOUGHTS));
    }
  }

  private shuffleStatus(): void {
    const waiting = new Set([...this.pendingPermission.values()].map((p) => p.agentId));
    const candidates = this.store.listAgents().filter((a) => !waiting.has(a.id));
    const a = candidates.length ? pick(candidates) : undefined;
    if (!a) return;
    const next: AgentStatus = a.status === "working" ? "idle" : "working";
    this.store.patchAgent(a.id, { status: next, activity: next === "idle" ? "coffee break" : "back on the task" });
    this.log(a.id, "system", next === "idle" ? "Task finished - going for a coffee." : "Picked up a new task.");
  }

  private peerChat(): void {
    const agents = this.store.listAgents();
    if (agents.length < 2) return;
    const from = pick(agents);
    const others = agents.filter((a) => a.id !== from.id);
    const to = pick(others);
    this.peer(from.id, to.id, pick(PEER_LINES));
    // Sometimes a third agent joins in, forming a group.
    if (Math.random() < 0.35 && others.length > 1) {
      const third = pick(others.filter((a) => a.id !== to.id));
      this.later(1_500, () => this.peer(to.id, third.id, "Looping you in - you know this part of the code best."));
    }
  }

  private peer(from: string, to: string, text: string): void {
    const fromName = this.store.getAgent(from)?.name ?? from;
    const toName = this.store.getAgent(to)?.name ?? to;
    this.store.conversations.message(from, to);
    this.log(from, "peer", `-> ${toName}: ${text}`, to);
    this.log(to, "peer", `<- ${fromName}: ${text}`, from);
    this.later(3_000, () => {
      this.store.conversations.message(to, from);
      this.log(to, "peer", `-> ${fromName}: Sure, give me a sec.`, from);
      this.log(from, "peer", `<- ${toName}: Sure, give me a sec.`, to);
    });
  }

  private askPermission(): void {
    const candidates = this.store.listAgents().filter((a) => a.status === "working");
    if (!candidates.length || this.pendingPermission.size >= 2) return;
    this.request(pick(candidates).id, pick(REQUESTS), false);
  }

  private request(agentId: string, req: (typeof REQUESTS)[number], retried: boolean): void {
    const id = `perm-${++this.seq}`;
    const title = `${req.permission}: ${req.patterns.join(", ")}`;
    this.pendingPermission.set(id, { agentId, req, retried });
    this.log(agentId, "system", `${retried ? "Asking again, narrower" : "Asking the boss"}: ${title}`);
    this.store.addPermission({ id, agentId, title, at: Date.now(), kind: "permission", permission: req.permission, patterns: req.patterns, always: req.always });
  }

  private log(agentId: string, kind: Parameters<OfficeStore["log"]>[0]["kind"], text: string, peer?: string): void {
    this.store.log({ id: `m${++this.seq}`, agentId, kind, text, at: Date.now(), peer });
  }

  private every(ms: number, fn: () => void): void {
    this.timers.push(setInterval(fn, ms));
  }

  private later(ms: number, fn: () => void): void {
    this.timers.push(setTimeout(fn, ms));
  }
}
