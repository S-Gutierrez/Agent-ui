import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchConfig, parseJsonc } from "../src/server/launcher.ts";
import { MemoryStore } from "../src/server/memory.ts";
import { agentDefinitions, clearProjectCaches, findRepoRoot } from "../src/server/project.ts";

let repo: string;
beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), "repo-"));
  await mkdir(path.join(repo, ".opencode", "agents"), { recursive: true });
  await mkdir(path.join(repo, ".opencode", "memory"), { recursive: true });
  await mkdir(path.join(repo, "packages", "api", "src"), { recursive: true });
  await writeFile(path.join(repo, ".opencode", "agents", "reviewer.md"), "---\ndescription: Reviews pull requests\nmode: primary\n---\nYou review code.");
  await writeFile(path.join(repo, ".opencode", "agents", "builder.md"), "No frontmatter here.");
  await writeFile(path.join(repo, ".opencode", "memory", "reviewer.md"), "# reviewer memory");
  clearProjectCaches();
});
afterAll(() => rm(repo, { recursive: true, force: true }));

describe("repository conventions", () => {
  it("finds the repo root from a subfolder", () => {
    expect(findRepoRoot(path.join(repo, "packages", "api", "src"))).toBe(repo);
  });

  it("reads agent definitions from .opencode/agents", () => {
    const defs = agentDefinitions(repo);
    expect([...defs.keys()].sort()).toEqual(["builder", "reviewer"]);
    expect(defs.get("reviewer")).toEqual({ name: "reviewer", description: "Reviews pull requests", mode: "primary" });
  });

  it("memory defaults to <repo>/.opencode/memory/<agent>.md even when opencode runs in a subfolder", async () => {
    const store = new MemoryStore({ officeDir: path.join(repo, "office-unused"), templates: ["{repo}/.opencode/memory/{agent}.md"] });
    const m = await store.read({ name: "reviewer", agentName: "reviewer", directory: path.join(repo, "packages", "api") });
    expect(m.content).toBe("# reviewer memory");
    expect(m.file).toBe(`${path.basename(repo)}/.opencode/memory/reviewer.md`);
  });
});

describe("launcher config", () => {
  it("parses jsonc (comments, trailing commas, // inside strings)", () => {
    expect(parseJsonc('{ // c\n "a": "http://x", /* b */ "b": [1,2,], }')).toEqual({ a: "http://x", b: [1, 2] });
  });

  it("keeps the project's peers options and version, forcing name = agent and peerPermissions ask", () => {
    const project = { permission: "ask", plugin: ["other-plugin", ["opencode-plugin-peers@0.2.4", { inboundPolicy: "hold", name: "shared", peerPermissions: "allow" }]] };
    const { content, notes } = launchConfig("reviewer", [project]);
    expect(JSON.parse(content)).toEqual({
      plugin: [["opencode-plugin-peers@0.2.4", { inboundPolicy: "hold", name: "reviewer", peerPermissions: "ask" }]],
    });
    expect(notes).toEqual([]);
  });

  it("adds the plugin when missing and warns when permission is not ask", () => {
    const { content, notes } = launchConfig("builder", [{ permission: { bash: "allow" } }]);
    expect(JSON.parse(content).plugin[0]).toEqual(["opencode-plugin-peers", { name: "builder", peerPermissions: "ask" }]);
    expect(notes.join(" ")).toMatch(/not listed/);
    expect(notes.join(" ")).toMatch(/not "ask"/);
  });
});
