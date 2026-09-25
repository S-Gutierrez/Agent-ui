import type { Decision, PermissionRule, RuleAction } from "../shared/permissions.ts";
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
  fixPeerName: (id: string) => request<{ ok: true; name: string }>("POST", `/api/agents/${enc(id)}/fix-peer-name`, {}),
  memory: (id: string) => request<{ content: string; exists: boolean; file: string }>("GET", `/api/agents/${enc(id)}/memory`),
  saveMemory: (id: string, content: string) => request("PUT", `/api/agents/${enc(id)}/memory`, { content }),
  decide: (permissionId: string, decision: Decision, opts: { patterns?: string[]; message?: string } = {}) =>
    request("POST", `/api/permissions/${enc(permissionId)}`, { decision, ...opts }),
  addRule: (rule: { permission: string; pattern: string; action: RuleAction }) => request<PermissionRule>("POST", "/api/rules", rule),
  updateRule: (id: string, patch: Partial<Pick<PermissionRule, "permission" | "pattern" | "action">>) =>
    request<PermissionRule>("PUT", `/api/rules/${enc(id)}`, patch),
  deleteRule: (id: string) => request("DELETE", `/api/rules/${enc(id)}`, {}),
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
