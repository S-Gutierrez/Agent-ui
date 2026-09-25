// Normalised model shared by server and client. Every agent backend (mock,
// opencode, ...) is translated into these shapes by a source adapter.

import type { PermissionRule } from "./permissions.ts";

export type AgentStatus = "working" | "idle" | "needs_review";

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  /** Short human-readable description of what the agent is doing right now. */
  activity?: string;
  /** Deterministic avatar look, derived from the id when not provided. */
  look?: AvatarLook;
}

export interface AvatarLook {
  skin: string;
  hair: string;
  shirt: string;
  pants: string;
  hairStyle: 0 | 1 | 2 | 3;
}

/** A conversation between agents. The first participant is the initiator. */
export interface Conversation {
  id: string;
  participants: string[];
  startedAt: number;
}

export type LogKind = "reasoning" | "text" | "tool" | "user" | "peer" | "system";

export interface LogEntry {
  id: string;
  agentId: string;
  kind: LogKind;
  text: string;
  at: number;
  /** For peer messages: the other agent. */
  peer?: string;
}

export interface PermissionRequest {
  id: string;
  agentId: string;
  title: string;
  at: number;
  /** "question" requests are answered in the agent's own chat, not with allow/deny. */
  kind?: "permission" | "question";
  /** opencode permission key, e.g. "bash", "edit", "webfetch". */
  permission?: string;
  /** What is being asked for right now, e.g. ["npm publish --dry-run"]. */
  patterns?: string[];
  /** The simplified pattern(s) an "always" approval would grant, e.g. ["npm publish *"]. */
  always?: string[];
}

export interface OfficeSnapshot {
  agents: Agent[];
  conversations: Conversation[];
  permissions: PermissionRequest[];
  rules: PermissionRule[];
  source: string;
}

/** Server -> client push messages (sent over SSE). */
export type ServerEvent =
  | { type: "snapshot"; snapshot: OfficeSnapshot }
  | { type: "log"; entry: LogEntry };
