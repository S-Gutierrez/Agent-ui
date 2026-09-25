import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent } from "../shared/types.ts";

export const MAX_MEMORY_BYTES = 256 * 1024;

/** Turns an agent name/id into a safe file stem: no separators, no dots, no traversal. */
export function memorySlug(s: string): string {
  const slug = s
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "agent";
}

/** Like memorySlug but keeps case (opencode agent names are file names, e.g. `Reviewer`). */
export function safeSegment(s: string): string {
  const seg = s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  return seg || "agent";
}

export interface MemoryOptions {
  /** Office-owned memory folder ({office}). */
  officeDir: string;
  /**
   * Where an agent's memory lives, first existing match wins. Variables:
   *   {office}  the office memory folder
   *   {project} the agent's project directory (where opencode runs)
   *   {agent}   the opencode agent name, e.g. `reviewer` (falls back to the display name)
   *   {slug}    lowercase slug of the agent name
   * Default: `{office}/{slug}.md`.
   */
  templates?: string[];
  /** Extra folders memory files may live in, besides {office} and the agent's project. */
  extraRoots?: string[];
}

export interface ResolvedMemory {
  file: string;
  /** Path shown in the UI, relative to the folder it lives in. */
  display: string;
}

const within = (root: string, file: string) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

/**
 * Each agent's personal memory is a Markdown file located through templates,
 * e.g. `{project}/agents/{agent}/memory.md`. Files are only read or written
 * inside allowed roots (office folder, the agent's project, extra roots), must
 * end in `.md`, and symlinks may not lead outside those roots.
 */
export class MemoryStore {
  readonly templates: string[];

  constructor(private readonly opts: MemoryOptions) {
    this.templates = opts.templates?.length ? opts.templates : ["{office}/{slug}.md"];
  }

  candidates(agent: Pick<Agent, "name" | "agentName" | "directory">): ResolvedMemory[] {
    const who = agent.agentName ?? agent.name;
    const vars: Record<string, string | undefined> = {
      office: path.resolve(this.opts.officeDir),
      project: agent.directory ? path.resolve(agent.directory) : undefined,
      agent: safeSegment(who),
      slug: memorySlug(who),
    };
    const roots = this.roots(agent);
    const out: ResolvedMemory[] = [];
    for (const t of this.templates) {
      let missing = false;
      const filled = t.replace(/\{(\w+)\}/g, (_, k: string) => {
        const v = vars[k];
        if (v === undefined) missing = true;
        return v ?? "";
      });
      if (missing) continue;
      const file = path.resolve(filled);
      if (path.extname(file).toLowerCase() !== ".md") continue;
      const root = roots.find((r) => within(r, file));
      if (!root) continue;
      out.push({ file, display: path.relative(path.dirname(root), file) || path.basename(file) });
    }
    return out;
  }

  async read(agent: Pick<Agent, "name" | "agentName" | "directory">): Promise<{ file: string; content: string; exists: boolean }> {
    const cands = this.candidates(agent);
    if (!cands.length) throw new Error("no memory location configured for this agent (check OFFICE_MEMORY_PATH)");
    for (const c of cands) {
      try {
        await this.assertNoEscape(agent, c.file);
        return { file: c.display, content: await readFile(c.file, "utf8"), exists: true };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return { file: cands[0]!.display, content: "", exists: false };
  }

  async write(agent: Pick<Agent, "name" | "agentName" | "directory">, content: string): Promise<void> {
    if (Buffer.byteLength(content, "utf8") > MAX_MEMORY_BYTES) throw new Error("memory file too large");
    const cands = this.candidates(agent);
    if (!cands.length) throw new Error("no memory location configured for this agent (check OFFICE_MEMORY_PATH)");
    // Write to the file that exists, otherwise create the first candidate.
    let target = cands[0]!.file;
    for (const c of cands) {
      try {
        await readFile(c.file);
        target = c.file;
        break;
      } catch {
        /* keep looking */
      }
    }
    await mkdir(path.dirname(target), { recursive: true });
    await this.assertNoEscape(agent, target);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, target);
  }

  private roots(agent: Pick<Agent, "directory">): string[] {
    return [this.opts.officeDir, agent.directory, ...(this.opts.extraRoots ?? [])].filter((r): r is string => !!r).map((r) => path.resolve(r));
  }

  /** Resolve symlinks of the file (or its nearest existing parent) and re-check the roots. */
  private async assertNoEscape(agent: Pick<Agent, "directory">, file: string): Promise<void> {
    let probe = file;
    let real: string | undefined;
    while (!real) {
      try {
        real = await realpath(probe);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        const up = path.dirname(probe);
        if (up === probe) break;
        probe = up;
      }
    }
    if (!real) return;
    const rest = path.relative(probe, file);
    const full = path.join(real, rest);
    const roots = await Promise.all(this.roots(agent).map((r) => realpath(r).catch(() => r)));
    if (!roots.some((r) => within(r, full))) throw new Error("memory file resolves outside the allowed folders");
  }
}
