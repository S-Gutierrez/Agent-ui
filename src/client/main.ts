import "./style.css";
import type { Placement } from "../shared/placement.ts";
import type { LogEntry, OfficeSnapshot } from "../shared/types.ts";
import { subscribe } from "./api.ts";
import {
  drawAlert,
  drawAvatar,
  drawBossChair,
  drawBossDesk,
  drawChair,
  drawChatBubble,
  drawCoffee,
  drawDesk,
  drawFloor,
  drawNameTag,
  drawPlant,
  drawSofa,
  drawThought,
  drawWalls,
} from "./draw.ts";
import { Camera } from "./iso.ts";
import { BOSS_LOOK, lookFor } from "./look.ts";
import { RulesPanel } from "./permissions-ui.ts";
import { Inbox, Logs, TerminalWindow } from "./ui.ts";
import { World, type Avatar } from "./world.ts";

const canvas = document.querySelector<HTMLCanvasElement>("#office")!;
const ctx = canvas.getContext("2d")!;
const hud = {
  source: document.querySelector<HTMLElement>("#source")!,
  conn: document.querySelector<HTMLElement>("#conn")!,
  stats: document.querySelector<HTMLElement>("#stats")!,
  inboxBtn: document.querySelector<HTMLButtonElement>("#inbox-btn")!,
  badge: document.querySelector<HTMLElement>("#inbox-badge")!,
  resetView: document.querySelector<HTMLButtonElement>("#reset-view")!,
  banner: document.querySelector<HTMLElement>("#sim-banner")!,
  warnings: document.querySelector<HTMLElement>("#warn-banner")!,
  windows: document.querySelector<HTMLElement>("#windows")!,
};

const world = new World();
const camera = new Camera();
const logs = new Logs();
const windows = new Map<string, TerminalWindow>();
const bubbles = new Map<string, { text: string; until: number; color: string }>();
let selected: string | undefined;
let hoverTile: { x: number; y: number } | undefined;
let manualCamera = false;
let zTop = 10;

const STATUS_COLOR = { working: "#4fc3f7", idle: "#9ccc65", needs_review: "#ffca28" } as const;
const BUBBLE_MS = 6_000;

/* ------------------------------------------------------------ inbox & windows */

const inbox = new Inbox((id) => openWindow(id, "chat"));
const rulesPanel = new RulesPanel();
hud.windows.append(inbox.root, rulesPanel.root);
hud.inboxBtn.onclick = () => {
  rulesPanel.toggle(false);
  inbox.toggle();
};
document.querySelector<HTMLButtonElement>("#rules-btn")!.onclick = () => {
  inbox.toggle(false);
  rulesPanel.toggle();
};
hud.resetView.onclick = () => {
  manualCamera = false;
  fitCamera();
};

function openWindow(agentId: string, tab?: "reasoning" | "chat" | "memory"): void {
  const agent = world.snapshot.agents.find((a) => a.id === agentId);
  if (!agent) return;
  selected = agentId;
  const existing = windows.get(agentId);
  if (existing) {
    focusWindow(existing);
    if (tab) existing.show(tab);
    return;
  }
  const win = new TerminalWindow(
    agent,
    logs,
    () => {
      windows.delete(agentId);
      if (selected === agentId) selected = undefined;
    },
    focusWindow,
    tab,
  );
  const n = windows.size;
  win.root.style.left = `${Math.min(innerWidth - 540, 24 + n * 28)}px`;
  win.root.style.top = `${72 + n * 28}px`;
  win.setPermissions(world.snapshot.permissions);
  windows.set(agentId, win);
  hud.windows.append(win.root);
  focusWindow(win);
}

function focusWindow(w: TerminalWindow): void {
  w.root.style.zIndex = String(++zTop);
  selected = w.agentId;
}

addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const top = [...windows.values()].sort((a, b) => Number(b.root.style.zIndex) - Number(a.root.style.zIndex))[0];
  top?.close();
});

/* ------------------------------------------------------------------ data */

function onSnapshot(s: OfficeSnapshot): void {
  const before = world.layout.width * 1000 + world.layout.height;
  world.update(s);
  if (!manualCamera && before !== world.layout.width * 1000 + world.layout.height) fitCamera();
  for (const [id, w] of windows) {
    const a = s.agents.find((x) => x.id === id);
    if (!a) w.close();
    else {
      w.setAgent(a);
      w.setPermissions(s.permissions);
    }
  }
  inbox.update(s);
  rulesPanel.update(s.rules);
  hud.source.textContent = s.source;
  hud.banner.hidden = s.source !== "simulation";
  hud.warnings.replaceChildren(
    ...s.warnings.map((w) => {
      const line = document.createElement("div");
      line.textContent = `! ${w}`;
      return line;
    }),
  );
  hud.warnings.hidden = s.warnings.length === 0;
  const n = s.permissions.length;
  hud.badge.textContent = String(n);
  hud.badge.hidden = n === 0;
  const count = (st: string) => s.agents.filter((a) => a.status === st).length;
  const talking = new Set(s.conversations.flatMap((c) => c.participants)).size;
  hud.stats.textContent = `${s.agents.length} agents - ${count("working")} working - ${count("idle")} idle - ${count("needs_review")} waiting - ${talking} chatting`;
}

function onLog(e: LogEntry): void {
  logs.add(e);
  const say = (text: string, color: string) => bubbles.set(e.agentId, { text, color, until: performance.now() + BUBBLE_MS });
  if (e.kind === "peer" && e.text.startsWith("->")) say(e.text.replace(/^->\s*[^:]*:\s*/, ""), "#4a90d9");
  else if (e.kind === "tool" && e.text.startsWith("send_message ->")) say(e.text.replace(/^send_message ->\s*[^:]*:\s*/, ""), "#4a90d9");
  else if (e.kind === "text") say(e.text, "#27ae60");
}

subscribe(
  (ev) => (ev.type === "snapshot" ? onSnapshot(ev.snapshot) : onLog(ev.entry)),
  (ok) => {
    hud.conn.classList.toggle("ok", ok);
    hud.conn.title = ok ? "connected" : "reconnecting...";
  },
);

/* ---------------------------------------------------------------- camera */

let dpr = 1;
function resize(): void {
  dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(innerWidth * dpr);
  canvas.height = Math.floor(innerHeight * dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  if (!manualCamera) fitCamera();
}
function fitCamera(): void {
  camera.fit(world.layout.width, world.layout.height, innerWidth, innerHeight - 48);
  camera.offsetY += 48;
}
addEventListener("resize", resize);
resize();

let drag: { x: number; y: number; ox: number; oy: number; moved: boolean } | undefined;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, ox: camera.offsetX, oy: camera.offsetY, moved: false };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  const t = camera.toTile(e.clientX, e.clientY);
  hoverTile = { x: Math.round(t.x), y: Math.round(t.y) };
  canvas.style.cursor = hitAvatar(e.clientX, e.clientY) || hitBoss(e.clientX, e.clientY) ? "pointer" : drag ? "grabbing" : "default";
  if (!drag) return;
  const dx = e.clientX - drag.x;
  const dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (drag.moved) {
    manualCamera = true;
    camera.offsetX = drag.ox + dx;
    camera.offsetY = drag.oy + dy;
  }
});
canvas.addEventListener("pointerup", (e) => {
  const wasDrag = drag?.moved;
  drag = undefined;
  if (wasDrag) return;
  const av = hitAvatar(e.clientX, e.clientY);
  if (av) openWindow(av.agent.id, av.agent.status === "needs_review" ? "chat" : undefined);
  else if (hitBoss(e.clientX, e.clientY)) inbox.toggle(true);
  else selected = undefined;
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    manualCamera = true;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const next = Math.max(0.5, Math.min(3, camera.scale * factor));
    const k = next / camera.scale;
    camera.offsetX = e.clientX - (e.clientX - camera.offsetX) * k;
    camera.offsetY = e.clientY - (e.clientY - camera.offsetY) * k;
    camera.scale = next;
  },
  { passive: false },
);

function avatarAnchor(av: Avatar) {
  const seated = av.arrived && av.target?.seated;
  const p = camera.toScreen(av.x, av.y);
  return { x: p.x, y: p.y + (seated ? -2 * camera.scale : 0) };
}

function hitAvatar(mx: number, my: number): Avatar | undefined {
  const s = camera.scale;
  for (const av of world.sorted().reverse()) {
    const p = avatarAnchor(av);
    if (mx > p.x - 12 * s && mx < p.x + 12 * s && my > p.y - 62 * s && my < p.y + 6 * s) return av;
  }
  return undefined;
}

function hitBoss(mx: number, my: number): boolean {
  const seat = world.layout.boss.seat;
  const p = camera.toScreen(seat.x + 0.5, seat.y + 0.5);
  const s = camera.scale;
  return Math.abs(mx - p.x) < 50 * s && my > p.y - 70 * s && my < p.y + 20 * s;
}

/* ---------------------------------------------------------------- render */

type Drawable = { depth: number; draw: () => void };

function frame(now: number, dt: number): void {
  world.step(dt);
  const L = world.layout;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = "#1e2229";
  ctx.fillRect(0, 0, innerWidth, innerHeight);

  drawWalls(ctx, camera, L.width, L.height);
  drawFloor(ctx, camera, L.width, L.height, hoverTile);

  const items: Drawable[] = [];
  const workingAt = new Set(
    [...world.avatars.values()].filter((a) => a.arrived && a.target?.seated && a.agent.status === "working").map((a) => a.agent.id),
  );
  for (const f of L.furniture) {
    const { x, y } = f.tile;
    switch (f.kind) {
      case "desk":
        items.push({ depth: x + y, draw: () => drawDesk(ctx, camera, x, y, workingAt.has(f.owner!), now) });
        break;
      case "chair":
        items.push({ depth: x + y - 0.3, draw: () => drawChair(ctx, camera, x, y) });
        break;
      case "boss-desk":
        items.push({ depth: x + y, draw: () => drawBossDesk(ctx, camera, x, y) });
        break;
      case "boss-chair":
        items.push({ depth: x + y - 0.3, draw: () => drawBossChair(ctx, camera, x, y) });
        items.push({ depth: x + y, draw: () => drawBoss(now) });
        break;
      case "coffee":
        items.push({ depth: x + y, draw: () => drawCoffee(ctx, camera, x, y, now) });
        break;
      case "plant":
        items.push({ depth: x + y, draw: () => drawPlant(ctx, camera, x, y) });
        break;
      case "sofa":
        items.push({ depth: x + y, draw: () => drawSofa(ctx, camera, x, y) });
        break;
    }
  }
  const overlays: Array<() => void> = [];
  for (const av of world.avatars.values()) {
    items.push({ depth: av.x + av.y + 0.1, draw: () => drawAgent(av, now, overlays) });
  }
  items.sort((a, b) => a.depth - b.depth).forEach((d) => d.draw());
  overlays.forEach((o) => o());
  drawConversationLinks();
}

function drawBoss(now: number): void {
  const seat = world.layout.boss.seat;
  const p = camera.toScreen(seat.x, seat.y);
  drawAvatar(ctx, p.x, p.y - 2 * camera.scale, camera.scale, BOSS_LOOK, { facing: 1, walking: false, seated: true, typing: false, holdingCup: false, t: now }, false);
  drawNameTag(ctx, p.x, p.y + 6 * camera.scale, "You (boss)", "#e3c27a", camera.scale);
}

function drawAgent(av: Avatar, now: number, overlays: Array<() => void>): void {
  const target: Placement | undefined = av.target;
  const seated = !!(av.arrived && target?.seated);
  const p = avatarAnchor(av);
  const s = camera.scale;
  const status = av.agent.status;
  drawAvatar(
    ctx,
    p.x,
    p.y,
    s,
    lookFor(av.agent.id, av.agent.look),
    {
      facing: av.facing,
      walking: !av.arrived,
      seated,
      typing: seated && status === "working",
      holdingCup: av.arrived && target?.zone === "coffee",
      t: now + (av.agent.id.charCodeAt(0) ?? 0) * 97,
    },
    selected === av.agent.id,
  );
  const headY = p.y - (seated ? 76 : 64) * s;
  overlays.push(() => {
    drawNameTag(ctx, p.x, p.y + 6 * s, av.agent.name, STATUS_COLOR[status], s);
    const bubble = bubbles.get(av.agent.id);
    if (bubble && bubble.until > now) {
      const alpha = Math.min(1, (bubble.until - now) / 800);
      drawChatBubble(ctx, p.x, headY - 6 * s, av.agent.name, bubble.text, bubble.color, alpha, s);
    } else if (status === "needs_review") drawAlert(ctx, p.x, headY, now, s);
    else if (status === "working" && av.arrived && target?.seated && target.zone === "desk") drawThought(ctx, p.x + 10 * s, headY, now, s);
  });
}

/** Faint dashed lines between participants of each active conversation. */
function drawConversationLinks(): void {
  ctx.save();
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = "rgba(74,144,217,0.45)";
  ctx.lineWidth = 1.5;
  for (const c of world.snapshot.conversations) {
    // Only link agents that are actually at the meeting (not e.g. waiting at the boss desk).
    const pts = c.participants.map((id) => world.avatars.get(id)).filter((a): a is Avatar => a?.target?.conversationId === c.id);
    for (let i = 1; i < pts.length; i++) {
      const a = avatarAnchor(pts[0]!);
      const b = avatarAnchor(pts[i]!);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y - 30 * camera.scale);
      ctx.lineTo(b.x, b.y - 30 * camera.scale);
      ctx.stroke();
    }
  }
  ctx.restore();
}

let last = performance.now();
function loop(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  frame(now, dt);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
