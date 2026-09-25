import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { MemoryStore } from "./memory.ts";
import type { AgentSource, PermissionReply } from "./sources/source.ts";
import type { OfficeStore } from "./store.ts";

export interface AppOptions {
  store: OfficeStore;
  source: AgentSource;
  memory: MemoryStore;
  /** Serve the built client from here (production). */
  staticDir?: string;
  /** Extra Host header values to accept besides localhost (e.g. behind a reverse proxy). */
  allowedHosts?: string[];
  /** If set, every /api request must carry `Authorization: Bearer <token>` or `?token=`. */
  token?: string;
}

const MAX_BODY = 300 * 1024;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createApp(opts: AppOptions) {
  const allowedHosts = new Set([...LOCAL_HOSTS, ...(opts.allowedHosts ?? [])]);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    setSecurityHeaders(res);
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      // DNS-rebinding guard: only answer to hostnames we expect.
      const host = (req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
      if (!allowedHosts.has(host)) throw new HttpError(403, "unexpected Host header");

      if (url.pathname.startsWith("/api/")) {
        checkToken(req, url, opts.token);
        if (req.method !== "GET" && req.method !== "HEAD") checkSameOrigin(req);
        await api(req, res, url, opts);
        return;
      }
      if (opts.staticDir) {
        await serveStatic(res, opts.staticDir, url.pathname);
        return;
      }
      throw new HttpError(404, "not found");
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) sendJson(res, status, { error: err instanceof HttpError ? err.message : "internal error" });
      else res.end();
    }
  };
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL, opts: AppOptions): Promise<void> {
  const { store, source, memory } = opts;
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent); // ["api", ...]
  const route = `${req.method} /${parts.slice(1).map((p, i) => (i === 1 ? ":id" : p)).join("/")}`;
  const id = parts[2] ?? "";

  switch (route) {
    case "GET /events":
      return streamEvents(req, res, store);
    case "GET /state":
      return sendJson(res, 200, store.snapshot());
    case "GET /agents/:id/log":
      requireAgent(store, id);
      return sendJson(res, 200, store.history(id));
    case "POST /agents/:id/message": {
      requireAgent(store, id);
      const body = await readJson(req);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text || text.length > 20_000) throw new HttpError(400, "text must be 1-20000 characters");
      await source.sendMessage(id, text);
      return sendJson(res, 202, { ok: true });
    }
    case "GET /agents/:id/memory": {
      const agent = requireAgent(store, id);
      const { content, exists, file } = await memory.read(agent.name);
      return sendJson(res, 200, { content, exists, file: path.basename(file) });
    }
    case "PUT /agents/:id/memory": {
      const agent = requireAgent(store, id);
      const body = await readJson(req);
      if (typeof body.content !== "string") throw new HttpError(400, "content must be a string");
      await memory.write(agent.name, body.content).catch((e: Error) => {
        throw new HttpError(400, e.message);
      });
      return sendJson(res, 200, { ok: true });
    }
    case "POST /permissions/:id": {
      if (!store.getPermission(id)) throw new HttpError(404, "no such permission request");
      const body = await readJson(req);
      const reply = body.reply as PermissionReply;
      if (!["once", "always", "reject"].includes(reply)) throw new HttpError(400, "reply must be once|always|reject");
      await source.replyPermission(id, reply);
      return sendJson(res, 202, { ok: true });
    }
  }
  throw new HttpError(404, "not found");
}

function streamEvents(req: IncomingMessage, res: ServerResponse, store: OfficeStore): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  send({ type: "snapshot", snapshot: store.snapshot() });
  const onEvent = (e: unknown) => send(e);
  store.on("event", onEvent);
  const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
  req.on("close", () => {
    clearInterval(ping);
    store.off("event", onEvent);
  });
}

function requireAgent(store: OfficeStore, id: string) {
  const agent = store.getAgent(id);
  if (!agent) throw new HttpError(404, "no such agent");
  return agent;
}

/**
 * CSRF guard. A random web page must not be able to drive your agents through
 * this localhost server, so state-changing requests need a JSON content type
 * (forces a CORS preflight, which we never approve) and, when the browser
 * sends one, an Origin whose host matches the Host header.
 */
function checkSameOrigin(req: IncomingMessage): void {
  const ct = (req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  if (ct !== "application/json") throw new HttpError(415, "content-type must be application/json");
  const origin = req.headers.origin;
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new HttpError(403, "bad origin");
    }
    if (originHost !== req.headers.host) throw new HttpError(403, "cross-origin request refused");
  }
}

function checkToken(req: IncomingMessage, url: URL, token: string | undefined): void {
  if (!token) return;
  const given = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? url.searchParams.get("token");
  if (given !== token) throw new HttpError(401, "missing or wrong token");
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
    /* fall through */
  }
  throw new HttpError(400, "body must be a JSON object");
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  );
}

async function serveStatic(res: ServerResponse, root: string, pathname: string): Promise<void> {
  const rootAbs = path.resolve(root);
  let file = path.resolve(rootAbs, `.${decodeURIComponent(pathname)}`);
  if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) throw new HttpError(403, "forbidden");
  let info = await stat(file).catch(() => undefined);
  if (info?.isDirectory()) {
    file = path.join(file, "index.html");
    info = await stat(file).catch(() => undefined);
  }
  if (!info?.isFile()) {
    file = path.join(rootAbs, "index.html");
    info = await stat(file).catch(() => undefined);
    if (!info) throw new HttpError(404, "not found");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}
