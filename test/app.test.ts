import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { MemoryStore, memorySlug } from "../src/server/memory.ts";
import type { AgentSource } from "../src/server/sources/source.ts";
import { OfficeStore } from "../src/server/store.ts";

let server: Server;
let base: string;
let dir: string;
const sent: Array<[string, string]> = [];
const replies: Array<[string, string]> = [];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "office-"));
  const store = new OfficeStore("test");
  store.upsertAgent({ id: "a1", name: "Ada Lovelace", status: "working" });
  store.addPermission({ id: "p1", agentId: "a1", title: "bash", at: 1 });
  const source: AgentSource = {
    name: "test",
    start: async () => {},
    stop: async () => {},
    sendMessage: async (id, text) => void sent.push([id, text]),
    replyPermission: async (id, reply) => void replies.push([id, reply]),
  };
  const app = createApp({ store, source, memory: new MemoryStore(dir) });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
});

const post = (p: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + p, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("HTTP API", () => {
  it("serves the snapshot", async () => {
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(200);
    const s = await res.json();
    expect(s.agents[0].status).toBe("needs_review");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("forwards chat messages to the source", async () => {
    const res = await post("/api/agents/a1/message", { text: "hi" });
    expect(res.status).toBe(202);
    expect(sent).toContainEqual(["a1", "hi"]);
  });

  it("validates permission replies", async () => {
    expect((await post("/api/permissions/p1", { reply: "yolo" })).status).toBe(400);
    expect((await post("/api/permissions/nope", { reply: "once" })).status).toBe(404);
    expect((await post("/api/permissions/p1", { reply: "reject" })).status).toBe(202);
    expect(replies).toContainEqual(["p1", "reject"]);
  });

  it("reads and writes memory files inside the memory dir only", async () => {
    const put = await fetch(`${base}/api/agents/a1/memory`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "# notes" }),
    });
    expect(put.status).toBe(200);
    expect(await readFile(path.join(dir, "ada-lovelace.md"), "utf8")).toBe("# notes");
    const got = await (await fetch(`${base}/api/agents/a1/memory`)).json();
    expect(got).toEqual({ content: "# notes", exists: true, file: "ada-lovelace.md" });
  });

  it("slugs cannot escape the directory", () => {
    expect(memorySlug("../../etc/passwd")).toBe("etc-passwd");
    expect(memorySlug("..")).toBe("agent");
    expect(memorySlug("C:\\Windows\\x")).toBe("c-windows-x");
  });

  describe("CSRF / DNS-rebinding protection", () => {
    it("rejects cross-origin writes", async () => {
      const res = await post("/api/agents/a1/message", { text: "pwn" }, { origin: "https://evil.example" });
      expect(res.status).toBe(403);
    });

    it("rejects simple (non-JSON) form posts", async () => {
      const res = await fetch(`${base}/api/agents/a1/message`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ text: "pwn" }),
      });
      expect(res.status).toBe(415);
    });

    it("rejects unexpected Host headers", async () => {
      const http = await import("node:http");
      const status = await new Promise<number>((resolve) => {
        const u = new URL(base);
        http.get({ host: u.hostname, port: u.port, path: "/api/state", headers: { host: "attacker.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode!);
        });
      });
      expect(status).toBe(403);
    });

    it("never sent a forbidden message", () => {
      expect(sent.map(([, t]) => t)).not.toContain("pwn");
    });
  });
});
