import type { OfficeStore } from "../store.ts";

export type PermissionReply = "once" | "always" | "reject";

/** A backend that populates the office with agents. */
export interface AgentSource {
  readonly name: string;
  start(store: OfficeStore): Promise<void>;
  /** Send a message from the user (the boss) to an agent. */
  sendMessage(agentId: string, text: string): Promise<void>;
  replyPermission(permissionId: string, reply: PermissionReply): Promise<void>;
  stop(): Promise<void>;
}
