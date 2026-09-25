import type { LogEntry, OfficeSnapshot, ServerEvent } from "../shared/types.ts";

const token = new URLSearchParams(location.search).get("token") ?? undefined;

function url(path: string): string {
  return token ? `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}` : path;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(url(path), {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
  return data as T;
}

const enc = encodeURIComponent;

export const api = {
  state: () => request<OfficeSnapshot>("GET", "/api/state"),
  log: (id: string) => request<LogEntry[]>("GET", `/api/agents/${enc(id)}/log`),
  send: (id: string, text: string) => request("POST", `/api/agents/${enc(id)}/message`, { text }),
  memory: (id: string) => request<{ content: string; exists: boolean; file: string }>("GET", `/api/agents/${enc(id)}/memory`),
  saveMemory: (id: string, content: string) => request("PUT", `/api/agents/${enc(id)}/memory`, { content }),
  reply: (permissionId: string, reply: "once" | "always" | "reject") => request("POST", `/api/permissions/${enc(permissionId)}`, { reply }),
};

export function subscribe(onEvent: (e: ServerEvent) => void, onStatus: (connected: boolean) => void): () => void {
  const es = new EventSource(url("/api/events"));
  es.onopen = () => onStatus(true);
  es.onerror = () => onStatus(false);
  es.onmessage = (m) => {
    try {
      onEvent(JSON.parse(m.data) as ServerEvent);
    } catch {
      /* ignore malformed */
    }
  };
  return () => es.close();
}
