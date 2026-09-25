import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { evaluate, type Decision, type PermissionRule, type RuleAction } from "../shared/permissions.ts";
import type { PermissionRequest } from "../shared/types.ts";
import type { AgentSource } from "./sources/source.ts";
import type { OfficeStore } from "./store.ts";

const MAX_PATTERN = 500;
const MAX_PATTERNS = 20;

export class ValidationError extends Error {}

/** The boss's standing rules, persisted as JSON (or kept in memory when no file is given). */
export class RuleStore {
  private rules: PermissionRule[] = [];
  private seq = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly file?: string) {}

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as { rules?: PermissionRule[] };
      this.rules = (data.rules ?? []).filter(
        (r) => r && typeof r.id === "string" && typeof r.pattern === "string" && typeof r.permission === "string" && (r.action === "allow" || r.action === "deny"),
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  list(): PermissionRule[] {
    return [...this.rules];
  }

  add(input: { permission: string; pattern: string; action: RuleAction }): PermissionRule {
    const rule = normaliseRule(input);
    const dup = this.rules.find((r) => r.permission === rule.permission && r.pattern === rule.pattern && r.action === rule.action);
    if (dup) return dup;
    // A new decision replaces an opposite rule for the very same pattern.
    this.rules = this.rules.filter((r) => !(r.permission === rule.permission && r.pattern === rule.pattern));
    const full: PermissionRule = { ...rule, id: `rule-${Date.now().toString(36)}-${++this.seq}`, createdAt: Date.now() };
    this.rules.push(full);
    this.persist();
    return full;
  }

  update(id: string, patch: Partial<Pick<PermissionRule, "permission" | "pattern" | "action">>): PermissionRule {
    const i = this.rules.findIndex((r) => r.id === id);
    if (i < 0) throw new ValidationError("no such rule");
    const cur = this.rules[i]!;
    const next = { ...cur, ...normaliseRule({ ...cur, ...patch }) };
    this.rules[i] = next;
    this.persist();
    return next;
  }

  remove(id: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((r) => r.id !== id);
    if (this.rules.length === before) return false;
    this.persist();
    return true;
  }

  /** Resolves once pending writes are on disk (tests, shutdown). */
  flush(): Promise<void> {
    return this.writing;
  }

  private persist(): void {
    const file = this.file;
    if (!file) return;
    const body = JSON.stringify({ version: 1, rules: this.rules }, null, 2);
    this.writing = this.writing.then(async () => {
      await mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, body, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, file);
    }).catch((err) => console.error("[rules] could not save:", err));
  }
}

function normaliseRule(input: { permission: string; pattern: string; action: RuleAction }) {
  const permission = String(input.permission ?? "").trim();
  const pattern = String(input.pattern ?? "").trim();
  if (!/^[\w*.-]{1,64}$/.test(permission)) throw new ValidationError("invalid permission name");
  if (!pattern || pattern.length > MAX_PATTERN) throw new ValidationError(`pattern must be 1-${MAX_PATTERN} characters`);
  if (input.action !== "allow" && input.action !== "deny") throw new ValidationError("action must be allow or deny");
  return { permission, pattern, action: input.action };
}

export function validatePatterns(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new ValidationError("patterns must be an array of strings");
  const out = value.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
  if (!out.length || out.length > MAX_PATTERNS) throw new ValidationError(`give 1-${MAX_PATTERNS} patterns`);
  if (out.some((p) => p.length > MAX_PATTERN)) throw new ValidationError(`patterns must be at most ${MAX_PATTERN} characters`);
  return [...new Set(out)];
}

const list = (xs: string[]) => xs.map((x) => `\`${x}\``).join(", ");

/**
 * Screens incoming permission requests against the boss's rules and carries
 * out the boss's decisions. opencode is only ever answered with "once" or
 * "reject" so that every standing approval lives in the (editable) rule list.
 */
export class PermissionDesk {
  constructor(
    private readonly store: OfficeStore,
    private readonly source: AgentSource,
    readonly rules: RuleStore,
  ) {
    store.screenPermission = (p) => this.screen(p);
    store.rulesProvider = () => this.rules.list();
  }

  /** Returns true when a rule answered the request, so nobody has to walk to the boss. */
  screen(p: PermissionRequest): boolean {
    if (p.kind === "question" || !p.permission) return false;
    const hit = evaluate(this.rules.list(), { permission: p.permission, patterns: p.patterns ?? [] });
    if (!hit) return false;
    const allowed = hit.action === "allow";
    const message = allowed ? undefined : `The boss has permanently denied \`${p.permission}\` for ${list([hit.rule.pattern])}. Do not ask again; find another approach.`;
    this.source.replyPermission(p.id, allowed ? "once" : "reject", message).catch((err) => console.error("[rules] auto-reply failed:", err));
    this.note(p.agentId, `${allowed ? "Auto-approved" : "Auto-denied"} by office rule ${hit.rule.permission}: ${hit.rule.pattern} (${p.title})`);
    return true;
  }

  async decide(id: string, decision: Decision, opts: { patterns?: string[]; message?: string } = {}): Promise<void> {
    const req = this.store.getPermission(id);
    if (!req) throw new ValidationError("no such permission request");
    if (req.kind === "question") throw new ValidationError("questions are answered in the agent's chat");
    const permission = req.permission ?? "*";
    const asked = req.patterns?.length ? req.patterns : [req.title];
    const suggested = req.always?.length ? req.always : asked;
    const patterns = opts.patterns ?? suggested;
    const extra = opts.message?.trim().slice(0, 2_000);

    switch (decision) {
      case "once":
        await this.reply(req, "once");
        this.note(req.agentId, `Boss approved this time: ${req.title}`);
        break;
      case "no":
        await this.reply(req, "reject", `The boss declined this request.${extra ? ` ${extra}` : ""}`);
        this.note(req.agentId, `Boss said no: ${req.title}`);
        break;
      case "restrict":
        await this.reply(
          req,
          "reject",
          `The boss did not approve this request because its scope is too broad (asked for ${list(asked)}; an "always" approval would grant ${list(suggested)}). ` +
            `Try again with a narrower, more specific \`${permission}\` request that only covers what you really need.${extra ? ` Boss's hint: ${extra}` : ""}`,
        );
        this.note(req.agentId, `Boss asked for a narrower request: ${req.title}`);
        break;
      case "always": {
        for (const pattern of patterns) this.rules.add({ permission, pattern, action: "allow" });
        const covered = evaluate(this.rules.list(), { permission, patterns: req.patterns ?? [] })?.action === "allow";
        if (covered) await this.reply(req, "once");
        else
          await this.reply(
            req,
            "reject",
            `The boss approved only ${list(patterns)} for \`${permission}\` from now on. This request is outside that scope; retry with a request inside it.`,
          );
        this.note(req.agentId, `Boss approved always for ${permission}: ${patterns.join(", ")}`);
        break;
      }
      case "never":
        for (const pattern of patterns) this.rules.add({ permission, pattern, action: "deny" });
        await this.reply(
          req,
          "reject",
          `The boss has permanently denied \`${permission}\` for ${list(patterns)}. Do not ask for this again; find another approach.${extra ? ` ${extra}` : ""}`,
        );
        this.note(req.agentId, `Boss denied forever for ${permission}: ${patterns.join(", ")}`);
        break;
      default:
        throw new ValidationError("unknown decision");
    }
    if (decision === "always" || decision === "never") this.applyToPending();
  }

  /** Re-screen requests that are still waiting, after the rules changed. */
  applyToPending(): void {
    for (const p of this.store.snapshot().permissions) {
      if (this.screen(p)) this.store.removePermission(p.id);
    }
    this.store.changed();
  }

  private async reply(req: PermissionRequest, reply: "once" | "reject", message?: string): Promise<void> {
    await this.source.replyPermission(req.id, reply, message);
    this.store.removePermission(req.id);
  }

  private note(agentId: string, text: string): void {
    this.store.log({ id: `perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, agentId, kind: "system", text, at: Date.now() });
  }
}
