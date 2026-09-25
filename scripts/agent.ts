// Start one opencode agent so that it fits the office conventions:
//   npm run agent -- <agent> --repo <path-to-repo> [-- extra opencode args]
//
// * runs `opencode --agent <agent>` in the repository
// * sets the peers plugin name to the agent name (and peerPermissions "ask")
//   for this process only, via OPENCODE_CONFIG_CONTENT
// * makes sure <repo>/.opencode/memory/<agent>.md exists

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { launchConfig, parseJsonc } from "../src/server/launcher.ts";
import { findRepoRoot, PEER_NAME_RE } from "../src/server/project.ts";

function usage(msg?: string): never {
  if (msg) console.error(`error: ${msg}\n`);
  console.error("usage: npm run agent -- <agent-name> --repo <path-to-repo> [-- extra opencode args]");
  process.exit(1);
}

const argv = process.argv.slice(2);
const dashdash = argv.indexOf("--");
const own = dashdash >= 0 ? argv.slice(0, dashdash) : argv;
const extra = dashdash >= 0 ? argv.slice(dashdash + 1) : [];
let repoArg = process.env.OFFICE_REPO;
const positional: string[] = [];
for (let i = 0; i < own.length; i++) {
  if (own[i] === "--repo") repoArg = own[++i];
  else if (own[i] === "-h" || own[i] === "--help") usage();
  else positional.push(own[i]!);
}
const agent = positional[0];
if (!agent) usage("missing agent name");
if (!repoArg) usage("missing --repo (or set OFFICE_REPO)");
if (!PEER_NAME_RE.test(agent)) usage(`"${agent}" cannot be a peer name (1-32 letters, digits, space, _ or -)`);

const repo = findRepoRoot(path.resolve(repoArg.replace(/^~(?=$|\/)/, homedir())));
const agentsDir = path.join(repo, ".opencode", "agents");
const agentFile = [path.join(agentsDir, `${agent}.md`), path.join(repo, ".opencode", "agent", `${agent}.md`)].find(existsSync);
if (!agentFile) {
  const available = existsSync(agentsDir) ? readdirSync(agentsDir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)) : [];
  usage(`no agent "${agent}" in ${agentsDir}${available.length ? ` (available: ${available.join(", ")})` : ""}`);
}

// Personal memory file.
const memoryFile = path.join(repo, ".opencode", "memory", `${agent}.md`);
if (!existsSync(memoryFile)) {
  mkdirSync(path.dirname(memoryFile), { recursive: true });
  writeFileSync(memoryFile, `# ${agent} - memory\n`, { flag: "wx" });
  console.log(`created ${path.relative(repo, memoryFile)}`);
}

// Config sources in opencode's precedence order (global < project).
const readConfig = (file: string) => {
  try {
    return parseJsonc(readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`warning: could not parse ${file}: ${(err as Error).message}`);
    return undefined;
  }
};
const globalDir = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode");
const configs = [
  ...["config.json", "opencode.json", "opencode.jsonc"].map((f) => readConfig(path.join(globalDir, f))),
  ...["opencode.json", "opencode.jsonc"].map((f) => readConfig(path.join(repo, f))),
].filter(Boolean);

// A locally installed copy (.opencode/plugins/*.js) would not be replaced by the npm entry.
for (const dir of [path.join(repo, ".opencode", "plugins"), path.join(globalDir, "plugins")]) {
  const local = existsSync(dir) ? readdirSync(dir).filter((f) => /peers/i.test(f)) : [];
  if (local.length) console.warn(`warning: ${dir} has ${local.join(", ")}; set the name with /peers-name ${agent} or the office's "rename peer" button.`);
}

const { content, notes } = launchConfig(agent, configs);
notes.forEach((n) => console.warn(`note: ${n}`));
console.log(`starting opencode --agent ${agent} in ${repo} (peer name "${agent}")`);

const isWin = process.platform === "win32";
const args = ["--agent", agent, ...extra];
const child = spawn(isWin ? "opencode.cmd" : "opencode", isWin ? args.map((a) => `"${a.replace(/"/g, '\\"')}"`) : args, {
  cwd: repo,
  stdio: "inherit",
  shell: isWin,
  env: { ...process.env, OPENCODE_CONFIG_CONTENT: content },
});
child.on("error", (err) => {
  console.error(`could not start opencode: ${err.message} (is it installed? npm install -g opencode-ai)`);
  process.exit(1);
});
child.on("exit", (code) => process.exit(code ?? 0));
