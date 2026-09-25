// Drives OpencodeSource against a fake `opencode serve` that speaks the same
// HTTP + SSE shapes (taken from @opencode-ai/sdk's generated types).

import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpencodeSource } from "../src/server/sources/opencode.ts";
import { OfficeStore } from "../src/server/store.ts";

interface Fake {
  url: string;
  emit: (type: string, properties: Record<string, unknown>) => void;
  requests: Array<{ method: string; url: string; body: string }>;
  close: () => Promise<void>;
}

async function fakeOpencode(agents: Record<string, string> = {}): Promise<Fake> {
  const clients: ServerResponse[] = [];
  const requests: Fake["requests"] = [];
  const now = Date.now();
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    requests.push({ method: req.method!, url: req.url!, body });
    const json = (v: unknown) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(v));
    };
    const path = req.url!.split("?")[0];
    if (path === "/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`);
      clients.push(res);
      return;
    }
    const all = [
      { id: "ses_a", title: "alice", time: { created: now, updated: now } },
      { id: "ses_b", title: "bob", time: { created: now, updated: now } },
      { id: "ses_child", title: "sub", parentID: "ses_a", time: { created: now, updated: now } },
      { id: "ses_old", title: "ancient", time: { created: 0, updated: 0 } },
    ].map((x) => (agents[x.id] ? { ...x, agent: agents[x.id], directory: "/work/proj" } : x));
    if (path === "/session") return json(all);
    const one = /^\/session\/([^/]+)$/.exec(path ?? "");
    if (one && one[1] !== "status" && req.method === "GET") return json(all.find((x) => x.id === one[1]));
    if (path === "/session/status") return json({ ses_a: { type: "busy" } });
    if (path === "/permission") return json([]);
    if (path?.endsWith("/message") && req.method === "GET")
      return json([
        {
          info: { id: "msg_1", role: "assistant" },
          parts: [{ id: "prt_1", sessionID: "ses_a", messageID: "msg_1", type: "reasoning", text: "Earlier thought" }],
        },
      ]);
    res.writeHead(204);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    emit: (type, properties) => clients.forEach((c) => c.write(`data: ${JSON.stringify({ type, properties })}\n\n`)),
    close: () =>
      new Promise((r) => {
        clients.forEach((c) => c.end());
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

const until = async (cond: () => boolean, ms = 2_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("OpencodeSource", () => {
  let fake: Fake;
  let store: OfficeStore;
  let source: OpencodeSource;

  beforeEach(async () => {
    fake = await fakeOpencode();
    store = new OfficeStore("test");
    source = new OpencodeSource({ urls: [fake.url] });
    await source.start(store);
    await until(() => store.listAgents().length === 2 && store.history("ses_a").length > 0);
    // Wait until the event stream is connected.
    await until(() => fake.requests.some((r) => r.url === "/event"));
    await new Promise((r) => setTimeout(r, 30));
  });

  afterEach(async () => {
    await source.stop();
    store.dispose();
    await fake.close();
  });

  it("loads recent top-level sessions as agents with their status and history", () => {
    const agents = Object.fromEntries(store.listAgents().map((a) => [a.id, a]));
    expect(Object.keys(agents).sort()).toEqual(["ses_a", "ses_b"]);
    expect(agents.ses_a!.name).toBe("alice");
    expect(agents.ses_a!.status).toBe("working");
    expect(agents.ses_b!.status).toBe("idle");
    expect(store.history("ses_a")[0]!.text).toBe("Earlier thought");
  });

  it("follows session.status events", async () => {
    fake.emit("session.status", { sessionID: "ses_b", status: { type: "busy" } });
    await until(() => store.getAgent("ses_b")!.status === "working");
    fake.emit("session.idle", { sessionID: "ses_b" });
    await until(() => store.getAgent("ses_b")!.status === "idle");
  });

  it("streams reasoning parts and deltas", async () => {
    fake.emit("message.updated", { sessionID: "ses_b", info: { id: "msg_9", role: "assistant" } });
    fake.emit("message.part.updated", {
      sessionID: "ses_b",
      part: { id: "prt_9", sessionID: "ses_b", messageID: "msg_9", type: "reasoning", text: "Let me" },
    });
    fake.emit("message.part.delta", { sessionID: "ses_b", messageID: "msg_9", partID: "prt_9", field: "text", delta: " think" });
    await until(() => store.history("ses_b").some((e) => e.text === "Let me think"));
    expect(store.history("ses_b").filter((e) => e.id === "prt_9")).toHaveLength(1);
  });

  it("puts agents with a permission request in front of the boss, and replies via the API", async () => {
    fake.emit("permission.asked", { id: "per_1", sessionID: "ses_a", permission: "bash", patterns: ["rm -rf dist"], metadata: {}, always: ["rm *"] });
    await until(() => store.snapshot().agents.find((a) => a.id === "ses_a")!.status === "needs_review");
    expect(store.snapshot().permissions[0]).toMatchObject({ title: "bash: rm -rf dist", permission: "bash", patterns: ["rm -rf dist"], always: ["rm *"] });

    await source.replyPermission("per_1", "once");
    const req = fake.requests.find((r) => r.url === "/permission/per_1/reply")!;
    expect(JSON.parse(req.body)).toEqual({ reply: "once" });

    await source.replyPermission("per_1", "reject", "narrower please");
    const rej = fake.requests.filter((r) => r.url === "/permission/per_1/reply").at(-1)!;
    expect(JSON.parse(rej.body)).toEqual({ reply: "reject", message: "narrower please" });

    fake.emit("permission.replied", { sessionID: "ses_a", requestID: "per_1", reply: "once" });
    await until(() => store.snapshot().permissions.length === 0);
  });

  it("detects opencode-plugin-peers conversations from both sides", async () => {
    // Sender side: alice calls send_message.
    fake.emit("message.part.updated", {
      sessionID: "ses_a",
      part: {
        id: "prt_s",
        sessionID: "ses_a",
        messageID: "msg_s",
        type: "tool",
        tool: "send_message",
        callID: "c1",
        state: { status: "running", input: { to: "bob", message: "Can you review my retry logic?" } },
      },
    });
    // Receiver side: bob gets a synthetic user message with peer metadata.
    fake.emit("message.updated", { sessionID: "ses_b", info: { id: "msg_r", role: "user" } });
    fake.emit("message.part.updated", {
      sessionID: "ses_b",
      part: {
        id: "prt_r",
        sessionID: "ses_b",
        messageID: "msg_r",
        type: "text",
        synthetic: true,
        text: '[peer message from "alice" @ /repo; sender endpoint: ep_alice]\nCan you review my retry logic?\n---\nReply with send_message.',
        metadata: { peerMessage: { version: 2, messageId: "m1", fromEndpointId: "ep_alice", toSessionId: "ses_b" } },
      },
    });
    await until(() => store.snapshot().conversations.length === 1);
    expect(store.snapshot().conversations[0]!.participants).toEqual(["ses_a", "ses_b"]);
    const peerLine = store.history("ses_b").find((e) => e.kind === "peer")!;
    expect(peerLine.text).toBe("<- alice: Can you review my retry logic?");

    // Next time bob answers by name, it is recognised immediately from the sender side.
    fake.emit("message.part.updated", {
      sessionID: "ses_b",
      part: {
        id: "prt_s2",
        sessionID: "ses_b",
        messageID: "msg_s2",
        type: "tool",
        tool: "send_message",
        callID: "c2",
        state: { status: "running", input: { to: "alice", message: "Looks good" } },
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(store.snapshot().conversations).toHaveLength(1);
    expect(store.snapshot().conversations[0]!.participants).toEqual(["ses_a", "ses_b"]);
  });

  it("sends the boss's chat messages with prompt_async", async () => {
    await source.sendMessage("ses_b", "hello there");
    const req = fake.requests.find((r) => r.url === "/session/ses_b/prompt_async")!;
    expect(JSON.parse(req.body)).toEqual({ parts: [{ type: "text", text: "hello there" }] });
  });
});

describe("OpencodeSource peers auto-discovery", () => {
  it("finds agents through the peers registry, names them by opencode agent and warns about auto-approval", async () => {
    const fake = await fakeOpencode({ ses_a: "reviewer", ses_b: "builder", ses_old: "reviewer" });
    const dir = await mkdtemp(nodePath.join(tmpdir(), "peers-"));
    const entry = (sessionId: string, name: string, peerPermissions: string) => ({
      version: 2,
      endpointId: `ep_${name}`,
      processId: "p1",
      sessionId,
      name,
      directory: "/work/proj",
      serverUrl: fake.url + "/",
      inboxToken: "SECRET-TOKEN",
      timestamps: { heartbeatAt: Date.now() },
      policy: { peerPermissions },
    });
    await writeFile(nodePath.join(dir, "p1.a.v2.json"), JSON.stringify(entry("ses_a", "backend", "ask")));
    await writeFile(nodePath.join(dir, "p1.b.v2.json"), JSON.stringify(entry("ses_b", "frontend", "allow")));
    // A stale entry and a non-loopback server must be ignored.
    await writeFile(nodePath.join(dir, "old.json"), JSON.stringify({ ...entry("ses_old", "old", "ask"), timestamps: { heartbeatAt: 0 } }));
    await writeFile(nodePath.join(dir, "evil.json"), JSON.stringify({ ...entry("ses_x", "evil", "ask"), serverUrl: "http://example.com" }));

    const store = new OfficeStore("test");
    const source = new OpencodeSource({ urls: [], peersDir: dir, peersPollMs: 50 });
    try {
      await source.start(store);
      await until(() => store.listAgents().length === 2);
      await new Promise((r) => setTimeout(r, 100));
      const byId = Object.fromEntries(store.listAgents().map((a) => [a.id, a]));
      // Only live registered peers - not every historic session on that server.
      expect(Object.keys(byId).sort()).toEqual(["ses_a", "ses_b"]);
      expect(byId.ses_a).toMatchObject({ name: "reviewer", agentName: "reviewer", directory: "/work/proj" });
      expect(byId.ses_b!.name).toBe("builder");
      expect(store.snapshot().warnings.join()).toMatch(/frontend/);
      expect(JSON.stringify(store.snapshot())).not.toContain("SECRET-TOKEN");
      expect(fake.requests.some((r) => r.url.includes("example.com"))).toBe(false);

      // send_message by peer name maps straight to the registered session.
      fake.emit("message.part.updated", {
        sessionID: "ses_a",
        part: { id: "t1", sessionID: "ses_a", messageID: "m1", type: "tool", tool: "send_message", state: { status: "running", input: { to: "frontend", message: "hi" } } },
      });
      await until(() => store.snapshot().conversations.length === 1);
      expect(store.snapshot().conversations[0]!.participants).toEqual(["ses_a", "ses_b"]);
    } finally {
      await source.stop();
      store.dispose();
      await fake.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("OpencodeSource naming conventions", () => {
  it("warns when a peer name differs from its agent name and can fix it with /peers-name", async () => {
    const fake = await fakeOpencode({ ses_a: "reviewer", ses_b: "build" });
    const dir = await mkdtemp(nodePath.join(tmpdir(), "peers-"));
    const now = Date.now();
    const entry = (sessionId: string, name: string) => ({
      version: 2, endpointId: `ep_${name}`, processId: "p", sessionId, name, directory: "/work/proj",
      serverUrl: fake.url, timestamps: { heartbeatAt: now }, policy: { peerPermissions: "ask" },
    });
    await writeFile(nodePath.join(dir, "a.json"), JSON.stringify(entry("ses_a", "proj-a3f2")));
    await writeFile(nodePath.join(dir, "b.json"), JSON.stringify(entry("ses_b", "build")));
    const store = new OfficeStore("test");
    const source = new OpencodeSource({ urls: [], peersDir: dir, peersPollMs: 50 });
    try {
      await source.start(store);
      await until(() => store.listAgents().length === 2 && store.snapshot().warnings.some((w) => w.includes("proj-a3f2")));
      const w = store.snapshot().warnings.join("\n");
      expect(w).toMatch(/"proj-a3f2" runs agent "reviewer"/);
      expect(w).toMatch(/built-in agent/);
      expect(store.getAgent("ses_a")).toMatchObject({ agentName: "reviewer", peerName: "proj-a3f2" });

      await expect(source.fixPeerName("ses_a")).resolves.toBe("reviewer");
      const cmd = fake.requests.find((r) => r.url === "/session/ses_a/command")!;
      expect(JSON.parse(cmd.body)).toEqual({ command: "peers-name", arguments: "reviewer" });
    } finally {
      await source.stop();
      store.dispose();
      await fake.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
