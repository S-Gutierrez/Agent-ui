// Pure helpers for scripts/agent.ts: build the per-process opencode config that
// makes the peer name equal the agent name.

export const PEERS_PKG = "opencode-plugin-peers";

type PluginSpec = string | [string, Record<string, unknown>];

/** Parse JSON with comments and trailing commas (opencode.jsonc). */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === "/" && n === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && n === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

const pkgOf = (spec: string) => {
  // "opencode-plugin-peers@0.2.4" -> "opencode-plugin-peers" (scoped packages keep their first "@")
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
};

/** Find the peers plugin entry (spec + options) in an opencode config object. */
export function findPeersPlugin(config: unknown): { spec: string; options: Record<string, unknown> } | undefined {
  const plugins = (config as { plugin?: PluginSpec[] } | undefined)?.plugin;
  if (!Array.isArray(plugins)) return undefined;
  for (const p of plugins) {
    const spec = Array.isArray(p) ? p[0] : p;
    if (typeof spec === "string" && pkgOf(spec) === PEERS_PKG) {
      return { spec, options: Array.isArray(p) && p[1] && typeof p[1] === "object" ? { ...p[1] } : {} };
    }
  }
  return undefined;
}

/**
 * Inline config (OPENCODE_CONFIG_CONTENT) for one agent. opencode de-duplicates
 * plugins by package name and the inline config wins, so this replaces the
 * project's peers entry for this process only, keeping its other options.
 */
export function launchConfig(agent: string, configs: unknown[]): { content: string; notes: string[] } {
  const notes: string[] = [];
  let found: { spec: string; options: Record<string, unknown> } | undefined;
  let permission: unknown;
  for (const c of configs) {
    found = findPeersPlugin(c) ?? found;
    const perm = (c as { permission?: unknown } | undefined)?.permission;
    if (perm !== undefined) permission = perm;
  }
  if (!found) notes.push(`${PEERS_PKG} is not listed in opencode.json; adding it for this agent.`);
  if (permission !== "ask") notes.push(`opencode "permission" is not "ask" - some actions may run without asking you.`);
  const options = { ...(found?.options ?? {}), name: agent, peerPermissions: "ask" };
  return { content: JSON.stringify({ plugin: [[found?.spec ?? PEERS_PKG, options]] }), notes };
}
