// Reads opencode-plugin-peers' local registry so the office can find every
// running agent by itself. Each plugin instance writes JSON files into
// `$XDG_DATA_HOME/opencode-plugin-peers/peers.d/` (default
// `~/.local/share/...`) containing its opencode server URL, the session it
// serves, its peer name and project directory.
//
// Only the fields below are read. The files also carry an inbox token; it is
// deliberately ignored and never leaves this module.

import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface PeerEndpoint {
  endpointId?: string;
  sessionId?: string;
  name?: string;
  directory?: string;
  serverUrl: string;
  peerPermissions?: string;
  heartbeatAt: number;
}

export function defaultPeersDir(env: NodeJS.ProcessEnv = process.env): string {
  const data = env.XDG_DATA_HOME?.trim() || path.join(homedir(), ".local", "share");
  return path.join(data, "opencode-plugin-peers", "peers.d");
}

/** Only talk to opencode servers on this machine. */
export function isLoopbackUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return (url.protocol === "http:" || url.protocol === "https:") && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined);

export async function readPeers(dir: string, maxAgeMs = 60_000, now = Date.now()): Promise<PeerEndpoint[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: PeerEndpoint[] = [];
  for (const f of files) {
    let e: Record<string, any>;
    try {
      e = JSON.parse(await readFile(path.join(dir, f), "utf8"));
    } catch {
      continue; // being rewritten, or not ours
    }
    const heartbeatAt = Number(e.timestamps?.heartbeatAt ?? e.heartbeatAt ?? 0);
    const serverUrl = str(e.serverUrl)?.replace(/\/+$/, "");
    if (!serverUrl || !isLoopbackUrl(serverUrl) || now - heartbeatAt > maxAgeMs) continue;
    out.push({
      endpointId: str(e.endpointId),
      sessionId: str(e.sessionId) ?? str(e.activeSessionId),
      name: str(e.name),
      directory: str(e.directory),
      serverUrl,
      peerPermissions: str(e.policy?.peerPermissions),
      heartbeatAt,
    });
  }
  return out;
}
