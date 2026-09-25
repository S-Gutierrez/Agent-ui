import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "./app.ts";
import { MemoryStore } from "./memory.ts";
import { MockSource } from "./sources/mock.ts";
import { OpencodeSource } from "./sources/opencode.ts";
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
const useMock = env.OFFICE_SOURCE === "mock" || opencodeUrls.length === 0;

const source: AgentSource = useMock
  ? new MockSource()
  : new OpencodeSource({
      urls: opencodeUrls,
      includeSubagents: env.OFFICE_INCLUDE_SUBAGENTS === "1",
      maxAgents: env.OFFICE_MAX_AGENTS ? Number(env.OFFICE_MAX_AGENTS) : undefined,
      maxSessionAgeMs: env.OFFICE_SESSION_MAX_AGE_H ? Number(env.OFFICE_SESSION_MAX_AGE_H) * 3600_000 : undefined,
      authorization: env.OPENCODE_AUTHORIZATION,
    });

const memoryDir = path.resolve(env.OFFICE_MEMORY_DIR ?? (useMock ? path.join(root, "examples/memory") : path.join(root, "memory")));
const store = new OfficeStore(source.name, Number(env.OFFICE_CONVERSATION_TTL_S ?? 60) * 1000);

const app = createApp({
  store,
  source,
  memory: new MemoryStore(memoryDir),
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
  console.log(`Agent Office API on http://${host}:${port}  (source: ${source.name}, memory: ${memoryDir})`);
  if (env.NODE_ENV === "production") console.log(`Open http://${host === "127.0.0.1" ? "localhost" : host}:${port}`);
});

const shutdown = async () => {
  await source.stop();
  store.dispose();
  server.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
