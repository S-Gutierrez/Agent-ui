import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/server/memory.ts";

let root: string;
let project: string;
let office: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "mem-"));
  project = path.join(root, "proj");
  office = path.join(root, "office");
  outside = path.join(root, "outside");
  await mkdir(path.join(project, "agents", "reviewer"), { recursive: true });
  await mkdir(office, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(project, "agents", "reviewer", "memory.md"), "# reviewer memory");
  await writeFile(path.join(outside, "secret.md"), "top secret");
});
afterAll(() => rm(root, { recursive: true, force: true }));

const reviewer = () => ({ name: "reviewer (backend)", agentName: "reviewer", directory: project });

describe("MemoryStore with a project template", () => {
  const store = () => new MemoryStore({ officeDir: office, templates: ["{project}/agents/{agent}/memory.md"] });

  it("reads <project>/agents/<agent>/memory.md using the opencode agent name", async () => {
    const m = await store().read(reviewer());
    expect(m).toEqual({ content: "# reviewer memory", exists: true, file: "proj/agents/reviewer/memory.md" });
  });

  it("writes back to the same file", async () => {
    await store().write(reviewer(), "# updated");
    expect(await readFile(path.join(project, "agents", "reviewer", "memory.md"), "utf8")).toBe("# updated");
  });

  it("creates the file for an agent that has none yet", async () => {
    const agent = { name: "planner", agentName: "planner", directory: project };
    expect((await store().read(agent)).exists).toBe(false);
    await store().write(agent, "# new");
    expect(await readFile(path.join(project, "agents", "planner", "memory.md"), "utf8")).toBe("# new");
  });

  it("agent names cannot traverse out of the folder", () => {
    const [c] = store().candidates({ name: "x", agentName: "../../outside/secret", directory: project });
    expect(c!.file).toBe(path.join(project, "agents", "outside-secret", "memory.md"));
  });

  it("refuses templates that point outside the allowed roots or to non-.md files", () => {
    const s = new MemoryStore({ officeDir: office, templates: [`${outside}/{agent}.md`, "{project}/agents/{agent}/memory.txt"] });
    expect(s.candidates(reviewer())).toEqual([]);
  });

  it("allows extra roots when configured", () => {
    const s = new MemoryStore({ officeDir: office, templates: [`${outside}/secret.md`], extraRoots: [outside] });
    expect(s.candidates(reviewer())).toHaveLength(1);
  });

  it("refuses symlinks that escape the allowed roots", async () => {
    await mkdir(path.join(project, "agents", "sneaky"), { recursive: true });
    await symlink(path.join(outside, "secret.md"), path.join(project, "agents", "sneaky", "memory.md"));
    await expect(store().read({ name: "sneaky", agentName: "sneaky", directory: project })).rejects.toThrow(/outside/);
  });

  it("falls back to the next template when the agent has no project directory", async () => {
    const s = new MemoryStore({ officeDir: office, templates: ["{project}/agents/{agent}/memory.md", "{office}/{slug}.md"] });
    const [c] = s.candidates({ name: "Ada", agentName: "Ada" });
    expect(c!.file).toBe(path.join(office, "ada.md"));
  });
});
