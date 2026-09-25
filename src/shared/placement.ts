// Decides where every agent should be standing, given what they are doing.
//
// Rules, highest priority first:
//   1. Needs the user's review/permission -> in front of the boss desk.
//   2. In a conversation with 2 agents     -> the initiator walks to the other
//                                             agent's desk; the other stays seated.
//   3. In a conversation with 3+ agents    -> everyone gathers at the desk of one
//                                             participant, picked at random (seeded
//                                             by the conversation id, so it is
//                                             stable while the conversation lasts).
//   4. Working                             -> seated at their own desk.
//   5. Idle                                -> in front of the coffee machine.

import type { Agent, Conversation } from "./types.ts";
import { key, nearestFreeTiles, type OfficeLayout, type Tile } from "./layout.ts";

export type Zone = "desk" | "visiting" | "hosting" | "boss" | "coffee";

export interface Placement {
  tile: Tile;
  /** Tile the agent should face once arrived. */
  lookAt: Tile;
  zone: Zone;
  seated: boolean;
  conversationId?: string;
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function conversationHost(conv: Conversation): string {
  const p = conv.participants;
  if (p.length === 2) return p[1]!;
  return p[hashString(conv.id) % p.length]!;
}

export function computePlacements(
  agents: readonly Agent[],
  conversations: readonly Conversation[],
  layout: OfficeLayout,
): Map<string, Placement> {
  const out = new Map<string, Placement>();
  const claimed = new Set<string>(layout.blocked);
  const byId = new Map(agents.map((a) => [a.id, a]));

  const claim = (agentId: string, p: Placement) => {
    claimed.add(key(p.tile));
    out.set(agentId, p);
  };
  const firstFree = (candidates: readonly Tile[], near: Tile): Tile => {
    const free = candidates.find((t) => !claimed.has(key(t)));
    if (free) return free;
    return nearestFreeTiles(near, layout.width, layout.height, claimed, 1)[0] ?? near;
  };

  // Seats belong to their owner, so reserve them for anyone who will sit.
  for (const d of layout.desks.values()) claimed.add(key(d.seat));

  // 1. Boss queue, in agent order.
  for (const a of agents) {
    if (a.status !== "needs_review") continue;
    const tile = firstFree(layout.boss.queue, layout.boss.queue[0]!);
    claim(a.id, { tile, lookAt: layout.boss.seat, zone: "boss", seated: false });
  }

  // 2 & 3. Conversations, most recent first so an agent in several
  // conversations joins the latest one.
  const sorted = [...conversations]
    .filter((c) => c.participants.filter((p) => byId.has(p)).length >= 2)
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const conv of sorted) {
    const participants = conv.participants.filter((p) => byId.has(p));
    const host = conversationHost({ ...conv, participants });
    const hostDesk = layout.desks.get(host);
    if (!hostDesk) continue;
    if (!out.has(host)) {
      claim(host, { tile: hostDesk.seat, lookAt: hostDesk.desk, zone: "hosting", seated: true, conversationId: conv.id });
    }
    for (const p of participants) {
      if (p === host || out.has(p)) continue;
      const tile = firstFree(hostDesk.visitorSpots, hostDesk.seat);
      claim(p, { tile, lookAt: hostDesk.seat, zone: "visiting", seated: false, conversationId: conv.id });
    }
  }

  // 4 & 5. Everyone else.
  for (const a of agents) {
    if (out.has(a.id)) continue;
    const desk = layout.desks.get(a.id);
    if (a.status === "working" && desk) {
      out.set(a.id, { tile: desk.seat, lookAt: desk.desk, zone: "desk", seated: true });
      continue;
    }
    const tile = firstFree(layout.coffee.spots, layout.coffee.machine);
    claim(a.id, { tile, lookAt: layout.coffee.machine, zone: "coffee", seated: false });
  }

  return out;
}
