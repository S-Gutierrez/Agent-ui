import { describe, expect, it } from "vitest";
import { buildLayout, key } from "../src/shared/layout.ts";
import { computePlacements, conversationHost } from "../src/shared/placement.ts";
import { findPath } from "../src/shared/pathfinding.ts";
import type { Agent, AgentStatus, Conversation } from "../src/shared/types.ts";

const ids = ["ada", "bob", "cyd", "dee", "eve"];
const agents = (statuses: Partial<Record<string, AgentStatus>> = {}): Agent[] =>
  ids.map((id) => ({ id, name: id, status: statuses[id] ?? "working" }));
const conv = (id: string, participants: string[], startedAt = 1): Conversation => ({ id, participants, startedAt });

describe("computePlacements", () => {
  const layout = buildLayout(ids);

  it("seats working agents at their own desk", () => {
    const p = computePlacements(agents(), [], layout);
    for (const id of ids) {
      expect(p.get(id)!.zone).toBe("desk");
      expect(p.get(id)!.tile).toEqual(layout.desks.get(id)!.seat);
      expect(p.get(id)!.seated).toBe(true);
    }
  });

  it("sends idle agents to the coffee machine on distinct tiles", () => {
    const p = computePlacements(agents({ ada: "idle", bob: "idle", cyd: "idle" }), [], layout);
    const tiles = ["ada", "bob", "cyd"].map((id) => {
      expect(p.get(id)!.zone).toBe("coffee");
      return key(p.get(id)!.tile);
    });
    expect(new Set(tiles).size).toBe(3);
  });

  it("sends agents needing review to the boss desk", () => {
    const p = computePlacements(agents({ bob: "needs_review", dee: "needs_review" }), [], layout);
    expect(p.get("bob")!.zone).toBe("boss");
    expect(p.get("dee")!.zone).toBe("boss");
    expect(p.get("bob")!.tile).not.toEqual(p.get("dee")!.tile);
    expect(p.get("bob")!.lookAt).toEqual(layout.boss.seat);
  });

  it("in a 1:1 conversation the initiator visits the other agent's desk", () => {
    const p = computePlacements(agents(), [conv("c1", ["ada", "cyd"])], layout);
    expect(p.get("cyd")!.zone).toBe("hosting");
    expect(p.get("cyd")!.tile).toEqual(layout.desks.get("cyd")!.seat);
    expect(p.get("ada")!.zone).toBe("visiting");
    expect(layout.desks.get("cyd")!.visitorSpots).toContainEqual(p.get("ada")!.tile);
  });

  it("in a group conversation everyone meets at one participant's desk", () => {
    const c = conv("group-42", ["ada", "bob", "eve", "dee"]);
    const host = conversationHost(c);
    expect(c.participants).toContain(host);
    const p = computePlacements(agents(), [c], layout);
    expect(p.get(host)!.zone).toBe("hosting");
    const spots = layout.desks.get(host)!.visitorSpots;
    for (const id of c.participants.filter((x) => x !== host)) {
      expect(p.get(id)!.zone).toBe("visiting");
      expect(spots).toContainEqual(p.get(id)!.tile);
    }
    // Stable across recomputation.
    expect(conversationHost(c)).toBe(host);
  });

  it("group hosts are spread across participants for different conversations", () => {
    const hosts = new Set<string>();
    for (let i = 0; i < 50; i++) hosts.add(conversationHost(conv(`c${i}`, ["ada", "bob", "cyd"])));
    expect(hosts.size).toBe(3);
  });

  it("review requests win over conversations", () => {
    const p = computePlacements(agents({ ada: "needs_review" }), [conv("c1", ["ada", "bob"])], layout);
    expect(p.get("ada")!.zone).toBe("boss");
    expect(p.get("bob")!.zone).toBe("hosting");
  });

  it("an agent in several conversations joins the latest", () => {
    const p = computePlacements(agents(), [conv("old", ["ada", "bob"], 1), conv("new", ["ada", "eve"], 2)], layout);
    expect(p.get("ada")!.conversationId).toBe("new");
  });

  it("ignores conversations with agents that are not in the office", () => {
    const p = computePlacements(agents(), [conv("c1", ["ada", "ghost"])], layout);
    expect(p.get("ada")!.zone).toBe("desk");
  });
});

describe("findPath", () => {
  it("routes around furniture and every agent can reach its targets", () => {
    const layout = buildLayout(ids);
    const p = computePlacements(agents({ ada: "idle", bob: "needs_review" }), [conv("c", ["cyd", "dee", "eve"])], layout);
    for (const placement of p.values()) {
      const path = findPath(layout.door, placement.tile, layout.width, layout.height, layout.blocked);
      expect(path.length).toBeGreaterThan(0);
      expect(path.at(-1)).toEqual(placement.tile);
      for (const t of path.slice(0, -1)) expect(layout.blocked.has(key(t))).toBe(false);
    }
  });

  it("returns [] when already at the destination", () => {
    expect(findPath({ x: 1, y: 1 }, { x: 1, y: 1 }, 5, 5, new Set())).toEqual([]);
  });
});
