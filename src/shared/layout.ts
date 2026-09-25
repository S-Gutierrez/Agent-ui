// Office floor plan, generated from the list of agents so that the room grows
// with the team. Coordinates are tile coordinates (x grows to the screen's
// lower-right, y to the lower-left, Habbo style). The back walls run along
// x = -1 and y = -1.

export interface Tile {
  x: number;
  y: number;
}

export type FurnitureKind = "desk" | "chair" | "boss-desk" | "boss-chair" | "coffee" | "plant" | "sofa";

export interface Furniture {
  kind: FurnitureKind;
  tile: Tile;
  /** Agent that owns this item (desks and chairs). */
  owner?: string;
  /** Tiles the item occupies, blocking movement. Chairs do not block. */
  blocks: Tile[];
}

export interface DeskSlot {
  owner: string;
  seat: Tile;
  desk: Tile;
  /** Where visiting agents stand, in preference order. */
  visitorSpots: Tile[];
}

export interface OfficeLayout {
  width: number;
  height: number;
  desks: Map<string, DeskSlot>;
  boss: { seat: Tile; desk: Tile[]; queue: Tile[] };
  coffee: { machine: Tile; spots: Tile[] };
  furniture: Furniture[];
  blocked: Set<string>;
  /** Where agents appear when they first join. */
  door: Tile;
}

export const key = (t: Tile): string => `${t.x},${t.y}`;

const DESK_COL_SPACING = 3;
const DESK_ROW_SPACING = 4;
const FIRST_SEAT_ROW = 6;

export function buildLayout(agentIds: readonly string[]): OfficeLayout {
  const n = Math.max(agentIds.length, 1);
  const cols = Math.min(5, Math.max(3, Math.ceil(Math.sqrt(n * 1.6))));
  const rows = Math.ceil(n / cols);
  const width = 1 + cols * DESK_COL_SPACING + 1;
  const height = FIRST_SEAT_ROW + rows * DESK_ROW_SPACING - 1;

  const furniture: Furniture[] = [];
  const desks = new Map<string, DeskSlot>();

  agentIds.forEach((owner, i) => {
    const x = 2 + (i % cols) * DESK_COL_SPACING;
    const y = FIRST_SEAT_ROW + Math.floor(i / cols) * DESK_ROW_SPACING;
    const seat = { x, y };
    const desk = { x, y: y + 1 };
    desks.set(owner, {
      owner,
      seat,
      desk,
      visitorSpots: [
        { x: x + 1, y },
        { x: x - 1, y },
        { x: x + 1, y: y - 1 },
        { x: x - 1, y: y - 1 },
        { x, y: y - 1 },
      ],
    });
    furniture.push({ kind: "chair", tile: seat, owner, blocks: [] });
    furniture.push({ kind: "desk", tile: desk, owner, blocks: [desk] });
  });

  // The boss (you) sits at the back, facing the room.
  const bossSeat = { x: 2, y: 1 };
  const bossDesk = [
    { x: 2, y: 2 },
    { x: 3, y: 2 },
  ];
  const bossQueue = [
    { x: 2, y: 3 },
    { x: 3, y: 3 },
    { x: 1, y: 3 },
    { x: 4, y: 3 },
    { x: 1, y: 2 },
    { x: 4, y: 2 },
    { x: 2, y: 4 },
    { x: 3, y: 4 },
    { x: 1, y: 4 },
    { x: 4, y: 4 },
    { x: 5, y: 3 },
    { x: 5, y: 4 },
  ];
  furniture.push({ kind: "boss-chair", tile: bossSeat, blocks: [] });
  furniture.push({ kind: "boss-desk", tile: bossDesk[0]!, blocks: bossDesk });

  const machine = { x: width - 1, y: 0 };
  furniture.push({ kind: "coffee", tile: machine, blocks: [machine] });
  furniture.push({ kind: "sofa", tile: { x: width - 1, y: 3 }, blocks: [{ x: width - 1, y: 3 }] });
  furniture.push({ kind: "plant", tile: { x: 0, y: 0 }, blocks: [{ x: 0, y: 0 }] });
  furniture.push({ kind: "plant", tile: { x: width - 1, y: height - 1 }, blocks: [{ x: width - 1, y: height - 1 }] });

  const blocked = new Set<string>();
  for (const f of furniture) for (const b of f.blocks) blocked.add(key(b));
  blocked.add(key(bossSeat));

  // Tiles reserved for desks and the boss queue are never used as coffee spots.
  const reserved = new Set<string>(blocked);
  for (const d of desks.values()) {
    reserved.add(key(d.seat));
    d.visitorSpots.forEach((s) => reserved.add(key(s)));
  }
  bossQueue.forEach((s) => reserved.add(key(s)));

  const coffeeSpots = nearestFreeTiles(machine, width, height, reserved, 40);

  return {
    width,
    height,
    desks,
    boss: { seat: bossSeat, desk: bossDesk, queue: bossQueue },
    coffee: { machine, spots: coffeeSpots },
    furniture,
    blocked,
    door: { x: 0, y: height - 1 },
  };
}

export function inBounds(t: Tile, width: number, height: number): boolean {
  return t.x >= 0 && t.y >= 0 && t.x < width && t.y < height;
}

/** Breadth-first flood from `origin`, returning free tiles closest first. */
export function nearestFreeTiles(
  origin: Tile,
  width: number,
  height: number,
  taken: ReadonlySet<string>,
  limit: number,
): Tile[] {
  const out: Tile[] = [];
  const seen = new Set<string>([key(origin)]);
  const queue: Tile[] = [origin];
  while (queue.length && out.length < limit) {
    const cur = queue.shift()!;
    for (const [dx, dy] of NEIGHBOURS) {
      const next = { x: cur.x + dx, y: cur.y + dy };
      const k = key(next);
      if (seen.has(k) || !inBounds(next, width, height)) continue;
      seen.add(k);
      queue.push(next);
      if (!taken.has(k)) out.push(next);
    }
  }
  return out;
}

export const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [0, 1],
  [-1, 0],
  [0, -1],
];
