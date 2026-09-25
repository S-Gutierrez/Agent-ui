import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { evaluate, isBroadPattern, wildcardMatch, type PermissionRule } from "../src/shared/permissions.ts";
import { RuleStore } from "../src/server/permissions.ts";

const rule = (permission: string, pattern: string, action: "allow" | "deny"): PermissionRule => ({ id: pattern, permission, pattern, action, createdAt: 0 });

describe("wildcardMatch", () => {
  it("follows opencode's wildcard semantics", () => {
    expect(wildcardMatch("git *", "git status")).toBe(true);
    expect(wildcardMatch("git *", "gitk")).toBe(false);
    expect(wildcardMatch("npm test*", "npm test")).toBe(true);
    expect(wildcardMatch("a?c", "abc")).toBe(true);
    expect(wildcardMatch("a.c", "abc")).toBe(false); // regex chars are literal
    expect(wildcardMatch("src/*.ts", "src/a/b.ts")).toBe(true); // * spans everything, like opencode
  });
});

describe("isBroadPattern", () => {
  it.each([
    ["*", true],
    ["git *", true],
    ["rm *", true],
    ["n*", true],
    ["git push origin feature/*", false],
    ["npm publish --dry-run", false],
    [".github/workflows/ci.yml", false],
  ])("%s -> %s", (p, broad) => expect(isBroadPattern(p)).toBe(broad));
});

describe("evaluate", () => {
  it("deny wins over allow", () => {
    const rules = [rule("bash", "*", "allow"), rule("bash", "rm *", "deny")];
    expect(evaluate(rules, { permission: "bash", patterns: ["rm -rf dist"] })?.action).toBe("deny");
    expect(evaluate(rules, { permission: "bash", patterns: ["ls"] })?.action).toBe("allow");
  });

  it("allow requires every pattern to be covered", () => {
    const rules = [rule("edit", "src/*", "allow")];
    expect(evaluate(rules, { permission: "edit", patterns: ["src/a.ts", "package.json"] })).toBeUndefined();
    expect(evaluate(rules, { permission: "edit", patterns: ["src/a.ts", "src/b.ts"] })?.action).toBe("allow");
  });

  it("rules are scoped to their permission, '*' applies to all", () => {
    expect(evaluate([rule("edit", "*", "allow")], { permission: "bash", patterns: ["ls"] })).toBeUndefined();
    expect(evaluate([rule("*", "*secret*", "deny")], { permission: "read", patterns: [".env.secret"] })?.action).toBe("deny");
  });
});

describe("RuleStore", () => {
  it("persists rules and replaces an opposite rule for the same pattern", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rules-"));
    const file = path.join(dir, "rules.json");
    const a = new RuleStore(file);
    a.add({ permission: "bash", pattern: "npm test*", action: "allow" });
    a.add({ permission: "bash", pattern: "npm test*", action: "deny" });
    await a.flush();
    const b = new RuleStore(file);
    await b.load();
    expect(b.list()).toMatchObject([{ permission: "bash", pattern: "npm test*", action: "deny" }]);
    expect(JSON.parse(await readFile(file, "utf8")).version).toBe(1);
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects invalid rules", () => {
    const s = new RuleStore();
    expect(() => s.add({ permission: "bash", pattern: " ", action: "allow" })).toThrow();
    expect(() => s.add({ permission: "../x", pattern: "a", action: "allow" })).toThrow();
    expect(() => s.add({ permission: "bash", pattern: "a", action: "maybe" as never })).toThrow();
  });
});
