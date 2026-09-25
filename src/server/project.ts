// Knowledge about the repository an agent works in:
//   <repo>/.opencode/agents/<agent>.md   opencode agent definitions
//   <repo>/.opencode/memory/<agent>.md   each agent's personal memory

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const BUILTIN_AGENTS = new Set(["build", "plan", "general", "explore", "scout", "compaction", "title", "summary"]);

/** Same rule as opencode-plugin-peers' `/peers-name`. */
export const PEER_NAME_RE = /^[A-Za-z0-9 _-]{1,32}$/;

const rootCache = new Map<string, string>();

/**
 * The repository folder for a working directory: the nearest ancestor that
 * contains `.opencode/`, else the nearest with `.git`, else the directory itself.
 */
export function findRepoRoot(dir: string): string {
  const start = path.resolve(dir);
  const cached = rootCache.get(start);
  if (cached) return cached;
  let found: string | undefined;
  for (const marker of [".opencode", ".git"]) {
    for (let d = start; ; d = path.dirname(d)) {
      if (existsSync(path.join(d, marker))) {
        found = d;
        break;
      }
      if (path.dirname(d) === d) break;
    }
    if (found) break;
  }
  const root = found ?? start;
  rootCache.set(start, root);
  return root;
}

export interface AgentDefinition {
  name: string;
  description?: string;
  mode?: string;
}

const defsCache = new Map<string, { at: number; defs: Map<string, AgentDefinition> }>();

/** Reads `<repo>/.opencode/agents/*.md` (and the legacy singular `agent/`), cached for a few seconds. */
export function agentDefinitions(repo: string, maxAgeMs = 10_000): Map<string, AgentDefinition> {
  const hit = defsCache.get(repo);
  if (hit && Date.now() - hit.at < maxAgeMs) return hit.defs;
  const defs = new Map<string, AgentDefinition>();
  for (const sub of ["agents", "agent"]) {
    const dir = path.join(repo, ".opencode", sub);
    let files: string[] = [];
    try {
      if (statSync(dir).isDirectory()) files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      const name = f.slice(0, -3);
      if (defs.has(name)) continue;
      let text = "";
      try {
        text = readFileSync(path.join(dir, f), "utf8").slice(0, 8_192);
      } catch {
        /* unreadable: still a defined agent */
      }
      defs.set(name, { name, ...frontmatter(text) });
    }
  }
  defsCache.set(repo, { at: Date.now(), defs });
  return defs;
}

function frontmatter(text: string): { description?: string; mode?: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!m) return {};
  const get = (key: string) => {
    const line = new RegExp(`^${key}:\\s*(.*)$`, "m").exec(m[1]!)?.[1]?.trim();
    return line ? line.replace(/^["']|["']$/g, "") : undefined;
  };
  return { description: get("description"), mode: get("mode") };
}

/** For tests. */
export function clearProjectCaches(): void {
  rootCache.clear();
  defsCache.clear();
}
