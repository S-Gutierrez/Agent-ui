// Office-level permission rules. opencode's own "always" reply approves a
// pattern suggested by the tool (e.g. `npm *`) that the boss cannot edit or
// revoke from outside. The office therefore keeps its own, editable rules and
// only ever answers opencode with "once" or "reject".

export type RuleAction = "allow" | "deny";

export interface PermissionRule {
  id: string;
  /** opencode permission key (bash, edit, webfetch, ...) or "*" for any. */
  permission: string;
  /** Wildcard pattern: `*` = any run of characters, `?` = one character. */
  pattern: string;
  action: RuleAction;
  createdAt: number;
}

/** What the boss can answer to a permission request. */
export type Decision =
  | "once" // approve this time
  | "always" // approve now and in future, for the (editable) patterns
  | "restrict" // reject and ask the agent to retry with a narrower request
  | "no" // reject this time
  | "never"; // reject now and in future, for the (editable) patterns

export const DECISIONS: readonly Decision[] = ["once", "always", "restrict", "no", "never"];

export function wildcardMatch(pattern: string, value: string): boolean {
  const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]")}$`);
  return re.test(value);
}

/**
 * Heuristic for "this pattern grants a lot": a bare wildcard, a wildcard in
 * the first word (`* foo`, `n*`), or a single word followed by a wildcard
 * (`git *`, `rm *`, `src/*`).
 */
export function isBroadPattern(pattern: string): boolean {
  const p = pattern.trim();
  if (!p || /^[*?]+$/.test(p) || p === "**" || p === "/**") return true;
  const words = p.split(/\s+/);
  if (/[*?]/.test(words[0]!)) return true;
  if (words.length === 2 && /^[*?]+$/.test(words[1]!)) return true;
  return false;
}

export interface RequestLike {
  permission: string;
  patterns: string[];
}

const applies = (rule: PermissionRule, req: RequestLike) => rule.permission === "*" || rule.permission === req.permission;

/**
 * deny wins over allow. A request is denied if any of its patterns hits a deny
 * rule, and allowed only if every pattern is covered by some allow rule.
 */
export function evaluate(rules: readonly PermissionRule[], req: RequestLike): { action: RuleAction; rule: PermissionRule } | undefined {
  const values = req.patterns.length ? req.patterns : ["*"];
  for (const r of rules) {
    if (r.action === "deny" && applies(r, req) && values.some((v) => wildcardMatch(r.pattern, v))) return { action: "deny", rule: r };
  }
  const allows = rules.filter((r) => r.action === "allow" && applies(r, req));
  let first: PermissionRule | undefined;
  for (const v of values) {
    const hit = allows.find((r) => wildcardMatch(r.pattern, v));
    if (!hit) return undefined;
    first ??= hit;
  }
  return first ? { action: "allow", rule: first } : undefined;
}
