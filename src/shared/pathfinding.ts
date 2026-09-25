import { inBounds, key, NEIGHBOURS, type Tile } from "./layout.ts";

/**
 * A* over the 4-connected tile grid. Returns the tiles to walk through,
 * excluding `from` and including `to`. Blocked tiles are impassable, except the
 * destination itself (so an agent can path to a chair). Returns [] when no
 * route exists or when already there.
 */
export function findPath(
  from: Tile,
  to: Tile,
  width: number,
  height: number,
  blocked: ReadonlySet<string>,
): Tile[] {
  if (from.x === to.x && from.y === to.y) return [];
  const goal = key(to);
  const h = (t: Tile) => Math.abs(t.x - to.x) + Math.abs(t.y - to.y);

  const open: Array<{ t: Tile; f: number }> = [{ t: from, f: h(from) }];
  const g = new Map<string, number>([[key(from), 0]]);
  const cameFrom = new Map<string, Tile>();

  while (open.length) {
    let best = 0;
    for (let i = 1; i < open.length; i++) if (open[i]!.f < open[best]!.f) best = i;
    const { t: cur } = open.splice(best, 1)[0]!;
    const ck = key(cur);
    if (ck === goal) {
      const path: Tile[] = [cur];
      let k = ck;
      while (cameFrom.has(k)) {
        const prev = cameFrom.get(k)!;
        k = key(prev);
        if (k !== key(from)) path.unshift(prev);
      }
      return path;
    }
    for (const [dx, dy] of NEIGHBOURS) {
      const next = { x: cur.x + dx, y: cur.y + dy };
      const nk = key(next);
      if (!inBounds(next, width, height)) continue;
      if (blocked.has(nk) && nk !== goal) continue;
      const cost = g.get(ck)! + 1;
      if (cost < (g.get(nk) ?? Infinity)) {
        g.set(nk, cost);
        cameFrom.set(nk, cur);
        open.push({ t: next, f: cost + h(next) });
      }
    }
  }
  return [];
}
