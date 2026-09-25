import { buildLayout, key, type OfficeLayout, type Tile } from "../shared/layout.ts";
import { findPath } from "../shared/pathfinding.ts";
import { computePlacements, type Placement } from "../shared/placement.ts";
import type { Agent, OfficeSnapshot } from "../shared/types.ts";
import type { Facing } from "./draw.ts";

const WALK_SPEED = 3.2; // tiles per second

export interface Avatar {
  agent: Agent;
  x: number;
  y: number;
  path: Tile[];
  target?: Placement;
  facing: Facing;
  /** Last time this avatar was re-pathed (for stuck detection). */
  arrived: boolean;
}

export function facingTowards(from: { x: number; y: number }, to: { x: number; y: number }): Facing {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 2;
  return dy >= 0 ? 1 : 3;
}

/** Client-side simulation: keeps avatars walking towards their placements. */
export class World {
  layout: OfficeLayout = buildLayout([]);
  avatars = new Map<string, Avatar>();
  snapshot: OfficeSnapshot = { agents: [], conversations: [], permissions: [], rules: [], source: "", warnings: [] };
  private layoutKey = "";

  update(snapshot: OfficeSnapshot): void {
    this.snapshot = snapshot;
    const ids = snapshot.agents.map((a) => a.id);
    const lk = ids.join("|");
    if (lk !== this.layoutKey) {
      this.layoutKey = lk;
      this.layout = buildLayout(ids);
    }
    const alive = new Set(ids);
    for (const id of this.avatars.keys()) if (!alive.has(id)) this.avatars.delete(id);

    const placements = computePlacements(snapshot.agents, snapshot.conversations, this.layout);
    for (const agent of snapshot.agents) {
      let av = this.avatars.get(agent.id);
      if (!av) {
        const d = this.layout.door;
        av = { agent, x: d.x, y: d.y, path: [], facing: 3, arrived: false };
        this.avatars.set(agent.id, av);
      }
      av.agent = agent;
      // Keep avatars inside the room if it shrank.
      av.x = Math.min(av.x, this.layout.width - 1);
      av.y = Math.min(av.y, this.layout.height - 1);
      const next = placements.get(agent.id);
      if (!next) continue;
      const changed = !av.target || key(av.target.tile) !== key(next.tile);
      av.target = next;
      if (changed) this.route(av);
    }
  }

  private route(av: Avatar): void {
    if (!av.target) return;
    // Continue from the tile we are about to enter so movement stays on-grid.
    const from = av.path[0] ?? { x: Math.round(av.x), y: Math.round(av.y) };
    const rest = findPath(from, av.target.tile, this.layout.width, this.layout.height, this.layout.blocked);
    const onGrid = av.path[0] ? [av.path[0]] : [];
    av.path = [...onGrid, ...rest];
    if (!av.path.length && (from.x !== av.target.tile.x || from.y !== av.target.tile.y)) {
      // No route (should not happen): teleport rather than get stuck.
      av.x = av.target.tile.x;
      av.y = av.target.tile.y;
    }
    av.arrived = av.path.length === 0;
  }

  step(dt: number): void {
    for (const av of this.avatars.values()) {
      let budget = WALK_SPEED * dt;
      while (budget > 0 && av.path.length) {
        const next = av.path[0]!;
        const dx = next.x - av.x;
        const dy = next.y - av.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 1e-6) av.facing = facingTowards(av, next);
        if (dist <= budget) {
          av.x = next.x;
          av.y = next.y;
          av.path.shift();
          budget -= dist;
        } else {
          av.x += (dx / dist) * budget;
          av.y += (dy / dist) * budget;
          budget = 0;
        }
      }
      if (!av.path.length && av.target) {
        av.arrived = true;
        av.facing = facingTowards(av.target.tile, av.target.lookAt);
      }
    }
  }

  /** Avatars sorted back-to-front for painting. */
  sorted(): Avatar[] {
    return [...this.avatars.values()].sort((a, b) => a.x + a.y - (b.x + b.y));
  }
}
