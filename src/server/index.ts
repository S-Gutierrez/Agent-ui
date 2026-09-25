import { existsSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { MemoryStore } from "./memory.ts";
import { PermissionDesk, RuleStore } from "./permissions.ts";
import { MockSource } from "./sources/mock.ts";
import { OpencodeSource } from "./sources/opencode.ts";
import { defaultPeersDir } from "./sources/peers-registry.ts";
import type { AgentSource } from "./sources/source.ts";
import { OfficeStore } from "./store.ts";

const env = process.env;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const port = Number(env.OFFICE_PORT ?? 4317);
// Loopback only by default: this server can prompt your agents and approve their permissions.
const host = env.OFFICE_HOST ?? "127.0.0.1";
const opencodeUrls = (env.OPENCODE_URLS ?? env.OPENCODE_URL ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Auto-discover running opencode-plugin-peers instances unless disabled.
const peersDir = env.OFFICE_DISCOVER_PEERS === "0" ? undefined : path.resolve(env.OFFICE_PEERS_DIR ?? defaultPeersDir());
const peersAvailable = !!peersDir && existsSync(peersDir);
const useMock = env.OFFICE_SOURCE === "mock" || (env.OFFICE_SOURCE !== "opencode" && opencodeUrls.length === 0 && !peersAvailable);

const source: AgentSource = useMock
  ? new MockSource()
  : new OpencodeSource({
      urls: opencodeUrls,
      peersDir,
      includeSubagents: env.OFFICE_INCLUDE_SUBAGENTS === "1",
      maxAgents: env.OFFICE_MAX_AGENTS ? Number(env.OFFICE_MAX_AGENTS) : undefined,
      maxSessionAgeMs: env.OFFICE_SESSION_MAX_AGE_H ? Number(env.OFFICE_SESSION_MAX_AGE_H) * 3600_000 : undefined,
      authorization: env.OPENCODE_AUTHORIZATION,
    });

const memoryDir = path.resolve(env.OFFICE_MEMORY_DIR ?? (useMock ? path.join(root, "examples/memory") : path.join(root, "memory")));
const splitList = (v: string | undefined) => (v ?? "").split(/[;\n]/).map((s) => s.trim()).filter(Boolean);
// e.g. OFFICE_MEMORY_PATH="{project}/agents/{agent}/memory.md" (several templates separated by ";")
const memory = new MemoryStore({
  officeDir: memoryDir,
  templates: splitList(env.OFFICE_MEMORY_PATH),
  extraRoots: splitList(env.OFFICE_MEMORY_ROOTS).map((r) => path.resolve(r)),
});
const store = new OfficeStore(source.name, Number(env.OFFICE_CONVERSATION_TTL_S ?? 60) * 1000);

// The boss's standing permission rules. Simulation mode keeps them in memory only.
const rulesFile = useMock ? undefined : path.resolve(env.OFFICE_RULES_FILE ?? path.join(root, ".office/permission-rules.json"));
const rules = new RuleStore(rulesFile);
await rules.load();
const desk = new PermissionDesk(store, source, rules);

const app = createApp({
  store,
  source,
  desk,
  memory,
  staticDir: env.NODE_ENV === "production" ? path.join(root, "dist") : undefined,
  allowedHosts: env.OFFICE_ALLOWED_HOSTS?.split(",").map((s) => s.trim().toLowerCase()),
  token: env.OFFICE_TOKEN || undefined,
});

if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1" && !env.OFFICE_TOKEN) {
  console.error(`Refusing to listen on ${host} without OFFICE_TOKEN set.`);
  process.exit(1);
}

await source.start(store);
const server = createServer((req, res) => void app(req, res));
server.listen(port, host, () => {
  console.log(`Agent Office API on http://${host}:${port}  (source: ${source.name})`);
  console.log(`Memory: ${memory.templates.join(" ; ")}  ({office} = ${memoryDir})`);
  if (peersDir && !useMock) console.log(`Peers registry: ${peersDir}${peersAvailable ? "" : " (not found yet)"}`);
  console.log(`Permission rules: ${rulesFile ?? "in memory (simulation)"} - ${rules.list().length} loaded`);
  if (env.NODE_ENV === "production") console.log(`Open http://${host === "127.0.0.1" ? "localhost" : host}:${port}`);
});

const shutdown = async () => {
  await source.stop();
  await rules.flush();
  store.dispose();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
