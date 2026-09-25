import type { OfficeStore } from "../store.ts";

// "always" exists in opencode but the office never sends it: standing
// approvals live in the office's own editable rules (see ../permissions.ts).
export type PermissionReply = "once" | "reject";

/** A backend that populates the office with agents. */
export interface AgentSource {
  readonly name: string;
  start(store: OfficeStore): Promise<void>;
  /** Send a message from the user (the boss) to an agent. */
  sendMessage(agentId: string, text: string): Promise<void>;
  /** `message` is shown to the agent (opencode passes it on with a rejection). */
  replyPermission(permissionId: string, reply: PermissionReply, message?: string): Promise<void>;
  stop(): Promise<void>;
}
