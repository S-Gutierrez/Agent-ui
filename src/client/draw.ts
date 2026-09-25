// Procedural pixel-ish drawing of the office. Everything is drawn from
// primitives at runtime - there are no bitmap assets (and none borrowed from
// Habbo, whose art is Sulake's copyright).

import type { AvatarLook } from "../shared/types.ts";
import { Camera, TILE_H, TILE_W, WALL_H } from "./iso.ts";

type Ctx = CanvasRenderingContext2D;

export const COLORS = {
  floorA: "#d9c7a7",
  floorB: "#cfbb98",
  floorLine: "rgba(0,0,0,0.08)",
  wallLeft: "#b9c7d6",
  wallRight: "#a6b5c6",
  wallTop: "#6d7d90",
  skirting: "#7a6650",
  wood: ["#b07a47", "#8e5f35", "#9c6a3d"] as const,
  darkWood: ["#5b3b25", "#3f2818", "#4b3020"] as const,
  metal: ["#9aa4ad", "#6f7880", "#7f8890"] as const,
};

export function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v + amt * 255)));
  const r = c((n >> 16) & 255);
  const g = c((n >> 8) & 255);
  const b = c(n & 255);
  return `rgb(${r},${g},${b})`;
}

/** Project a tile *corner* (not centre). */
function corner(cam: Camera, cx: number, cy: number, z = 0) {
  return cam.toScreen(cx - 0.5, cy - 0.5, z);
}

function poly(ctx: Ctx, pts: Array<{ x: number; y: number }>, fill: string, stroke?: string): void {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/**
 * An isometric box on the floor grid. (x, y) is the tile, w/d the footprint in
 * tiles, inset shrinks the footprint, z/h are in unscaled pixels.
 */
export function isoBox(
  ctx: Ctx,
  cam: Camera,
  x: number,
  y: number,
  opts: { w?: number; d?: number; inset?: number; insetX?: number; insetY?: number; z?: number; h: number; colors: readonly [string, string, string] },
): void {
  const { w = 1, d = 1, inset = 0, z = 0, h, colors } = opts;
  const ix = opts.insetX ?? inset;
  const iy = opts.insetY ?? inset;
  const x0 = x + ix,
    y0 = y + iy,
    x1 = x + w - ix,
    y1 = y + d - iy;
  const [top, left, right] = colors;
  const outline = "rgba(0,0,0,0.25)";
  // Left-front face (y = y1) and right-front face (x = x1).
  poly(ctx, [corner(cam, x0, y1, z), corner(cam, x1, y1, z), corner(cam, x1, y1, z + h), corner(cam, x0, y1, z + h)], left, outline);
  poly(ctx, [corner(cam, x1, y0, z), corner(cam, x1, y1, z), corner(cam, x1, y1, z + h), corner(cam, x1, y0, z + h)], right, outline);
  poly(ctx, [corner(cam, x0, y0, z + h), corner(cam, x1, y0, z + h), corner(cam, x1, y1, z + h), corner(cam, x0, y1, z + h)], top, outline);
}

/* ------------------------------------------------------------------ room */

export function drawFloor(ctx: Ctx, cam: Camera, width: number, height: number, highlight?: { x: number; y: number }): void {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pts = [corner(cam, x, y), corner(cam, x + 1, y), corner(cam, x + 1, y + 1), corner(cam, x, y + 1)];
      const hl = highlight && highlight.x === x && highlight.y === y;
      poly(ctx, pts, hl ? "#efe2c6" : (x + y) % 2 ? COLORS.floorA : COLORS.floorB, COLORS.floorLine);
    }
  }
  // Floor edge thickness, Habbo style.
  const t = 8;
  poly(ctx, [corner(cam, 0, height), corner(cam, width, height), corner(cam, width, height, -t), corner(cam, 0, height, -t)], "#9c8763");
  poly(ctx, [corner(cam, width, 0), corner(cam, width, height), corner(cam, width, height, -t), corner(cam, width, 0, -t)], "#8a7654");
}

export function drawWalls(ctx: Ctx, cam: Camera, width: number, height: number): void {
  // Left wall along x = 0, right wall along y = 0.
  poly(ctx, [corner(cam, 0, height), corner(cam, 0, 0), corner(cam, 0, 0, WALL_H), corner(cam, 0, height, WALL_H)], COLORS.wallLeft);
  poly(ctx, [corner(cam, 0, 0), corner(cam, width, 0), corner(cam, width, 0, WALL_H), corner(cam, 0, 0, WALL_H)], COLORS.wallRight);
  // Wall tops.
  const th = 0.18;
  poly(ctx, [corner(cam, -th, height, WALL_H), corner(cam, -th, -th, WALL_H), corner(cam, 0, 0, WALL_H), corner(cam, 0, height, WALL_H)], COLORS.wallTop);
  poly(ctx, [corner(cam, -th, -th, WALL_H), corner(cam, width, -th, WALL_H), corner(cam, width, 0, WALL_H), corner(cam, 0, 0, WALL_H)], COLORS.wallTop);
  // Skirting boards.
  poly(ctx, [corner(cam, 0, height), corner(cam, 0, 0), corner(cam, 0, 0, 6), corner(cam, 0, height, 6)], COLORS.skirting);
  poly(ctx, [corner(cam, 0, 0), corner(cam, width, 0), corner(cam, width, 0, 6), corner(cam, 0, 0, 6)], COLORS.skirting);

  // Windows on the left wall.
  for (let y = 3; y < height - 1; y += 4) {
    const a = corner(cam, 0, y, 30),
      b = corner(cam, 0, y + 2, 30),
      c = corner(cam, 0, y + 2, 78),
      d = corner(cam, 0, y, 78);
    poly(ctx, [a, b, c, d], "#e9f3fb", "#5d6b7a");
    poly(ctx, [corner(cam, 0, y + 0.15, 34), corner(cam, 0, y + 1.85, 34), corner(cam, 0, y + 1.85, 74), corner(cam, 0, y + 0.15, 74)], "#9fd0f0");
    const m1 = corner(cam, 0, y + 1, 30),
      m2 = corner(cam, 0, y + 1, 78);
    ctx.strokeStyle = "#5d6b7a";
    ctx.beginPath();
    ctx.moveTo(m1.x, m1.y);
    ctx.lineTo(m2.x, m2.y);
    ctx.stroke();
  }
  // A whiteboard on the right wall.
  if (width > 8) {
    const x = Math.floor(width / 2) - 1;
    poly(ctx, [corner(cam, x, 0, 34), corner(cam, x + 3, 0, 34), corner(cam, x + 3, 0, 80), corner(cam, x, 0, 80)], "#fbfbfb", "#8a939c");
    ctx.strokeStyle = "#4a90d9";
    ctx.lineWidth = 2 * cam.scale;
    const p = [corner(cam, x + 0.4, 0, 60), corner(cam, x + 1.2, 0, 70), corner(cam, x + 1.9, 0, 52), corner(cam, x + 2.6, 0, 66)];
    ctx.beginPath();
    p.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.stroke();
    ctx.lineWidth = 1;
  }
}

/* ------------------------------------------------------------- furniture */

export function drawDesk(ctx: Ctx, cam: Camera, x: number, y: number, screenOn: boolean, t: number): void {
  // Legs
  isoBox(ctx, cam, x, y, { insetX: 0.08, insetY: 0.12, h: 22, colors: [COLORS.wood[1], COLORS.wood[1], COLORS.wood[2]] });
  isoBox(ctx, cam, x, y, { insetX: 0.02, insetY: 0.06, z: 22, h: 4, colors: COLORS.wood });
  // Monitor (seen from behind; it faces the chair at y - 1).
  isoBox(ctx, cam, x, y, { insetX: 0.46, insetY: 0.5, d: 1, z: 26, h: 6, colors: COLORS.metal });
  isoBox(ctx, cam, x, y, { insetX: 0.18, insetY: 0.36, d: 0.55, z: 30, h: 24, colors: ["#2d3238", "#23272c", "#1b1e22"] });
  if (screenOn) {
    // Screen glow spilling above the monitor.
    const c = cam.toScreen(x - 0.1, y - 0.25, 44);
    const pulse = 0.35 + 0.15 * Math.sin(t / 300);
    const g = ctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 28 * cam.scale);
    g.addColorStop(0, `rgba(120,200,255,${pulse})`);
    g.addColorStop(1, "rgba(120,200,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(c.x - 30 * cam.scale, c.y - 30 * cam.scale, 60 * cam.scale, 60 * cam.scale);
  }
  // Keyboard and mug.
  isoBox(ctx, cam, x, y, { insetX: 0.25, insetY: 0.08, d: 0.3, z: 26, h: 2, colors: ["#e6e6e6", "#b9b9b9", "#c9c9c9"] });
  isoBox(ctx, cam, x, y, { insetX: 0.8, insetY: 0.7, z: 26, h: 7, colors: ["#fafafa", "#d64545", "#b83a3a"] });
}

export function drawChair(ctx: Ctx, cam: Camera, x: number, y: number, color = "#3b4a5a"): void {
  isoBox(ctx, cam, x, y, { inset: 0.44, h: 10, colors: COLORS.metal });
  isoBox(ctx, cam, x, y, { inset: 0.22, z: 10, h: 4, colors: [color, shade(color, -0.1), shade(color, -0.15)] });
  // Backrest on the -y side (the sitter faces +y, towards the desk).
  isoBox(ctx, cam, x, y, { insetX: 0.22, insetY: 0.14, d: 0.3, z: 14, h: 20, colors: [color, shade(color, -0.1), shade(color, -0.15)] });
}

export function drawBossDesk(ctx: Ctx, cam: Camera, x: number, y: number): void {
  isoBox(ctx, cam, x, y, { w: 2, insetX: 0.02, insetY: 0.1, h: 26, colors: COLORS.darkWood });
  isoBox(ctx, cam, x, y, { w: 2, inset: 0, z: 26, h: 4, colors: ["#6d4830", "#4d321f", "#5a3b26"] });
  // Name plate.
  const p = cam.toScreen(x + 0.5, y + 0.5, 14);
  ctx.save();
  ctx.fillStyle = "#e3c27a";
  ctx.font = `bold ${Math.round(8 * cam.scale)}px monospace`;
  ctx.textAlign = "center";
  ctx.fillText("BOSS", p.x, p.y);
  ctx.restore();
  // Laptop and papers.
  isoBox(ctx, cam, x + 1, y, { insetX: 0.2, insetY: 0.25, z: 30, h: 2, colors: ["#c0c6cc", "#8f969c", "#9aa1a7"] });
  isoBox(ctx, cam, x, y, { insetX: 0.2, insetY: 0.3, z: 30, h: 3, colors: ["#fdfdfd", "#dcdcdc", "#e6e6e6"] });
}

export function drawBossChair(ctx: Ctx, cam: Camera, x: number, y: number): void {
  drawChair(ctx, cam, x, y, "#7a1f2b");
  isoBox(ctx, cam, x, y, { insetX: 0.22, insetY: 0.14, d: 0.3, z: 34, h: 10, colors: ["#7a1f2b", "#5e1721", "#681a25"] });
}

export function drawCoffee(ctx: Ctx, cam: Camera, x: number, y: number, t: number): void {
  isoBox(ctx, cam, x, y, { inset: 0.08, h: 30, colors: ["#555c63", "#3e444a", "#484e55"] });
  isoBox(ctx, cam, x, y, { inset: 0.12, z: 30, h: 40, colors: ["#c8ced3", "#9aa2a8", "#aab1b7"] });
  isoBox(ctx, cam, x, y, { inset: 0.14, z: 70, h: 10, colors: ["#303539", "#25292c", "#2b2f33"] });
  // Coffee sign + light.
  const s = cam.toScreen(x + 0.1, y + 0.35, 58);
  ctx.save();
  ctx.fillStyle = "#6b3e1e";
  ctx.font = `bold ${Math.round(7 * cam.scale)}px monospace`;
  ctx.textAlign = "center";
  ctx.fillText("COFFEE", s.x, s.y);
  const l = cam.toScreen(x + 0.3, y + 0.35, 46);
  ctx.fillStyle = Math.sin(t / 400) > 0 ? "#ff5a4f" : "#8a2a24";
  ctx.beginPath();
  ctx.arc(l.x, l.y, 2 * cam.scale, 0, Math.PI * 2);
  ctx.fill();
  // Steam.
  for (let i = 0; i < 3; i++) {
    const phase = (t / 1200 + i / 3) % 1;
    const p = cam.toScreen(x + 0.25, y + 0.55, 42 + phase * 30);
    ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - phase)})`;
    ctx.beginPath();
    ctx.arc(p.x + Math.sin(phase * 6 + i) * 3 * cam.scale, p.y, (2 + phase * 3) * cam.scale, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawPlant(ctx: Ctx, cam: Camera, x: number, y: number): void {
  isoBox(ctx, cam, x, y, { inset: 0.28, h: 16, colors: ["#b5653a", "#8f4e2c", "#9e5732"] });
  const c = cam.toScreen(x, y, 36);
  const s = cam.scale;
  const leaves: Array<[number, number, number, string]> = [
    [0, -6, 11, "#3f8f3a"],
    [-8, 2, 9, "#4ea447"],
    [8, 2, 9, "#357a31"],
    [0, 6, 9, "#4ea447"],
  ];
  for (const [dx, dy, r, col] of leaves) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.arc(c.x + dx * s, c.y + dy * s, r * s, 0, Math.PI * 2);
    ctx.fill();
  }
}

export function drawSofa(ctx: Ctx, cam: Camera, x: number, y: number): void {
  const col = ["#5a7fb0", "#46658d", "#4e709c"] as const;
  isoBox(ctx, cam, x, y, { insetX: 0.1, insetY: 0.02, h: 14, colors: col });
  isoBox(ctx, cam, x, y, { insetX: 0.62, insetY: 0.02, z: 14, h: 18, colors: col });
}

/* ---------------------------------------------------------------- avatars */

export type Facing = 0 | 1 | 2 | 3; // +x, +y, -x, -y

export interface AvatarPose {
  facing: Facing;
  walking: boolean;
  seated: boolean;
  typing: boolean;
  holdingCup: boolean;
  t: number;
}

/** Draw an avatar with its feet at canvas point (sx, sy). */
export function drawAvatar(ctx: Ctx, sx: number, sy: number, scale: number, look: AvatarLook, pose: AvatarPose, selected: boolean): void {
  const front = pose.facing === 0 || pose.facing === 1;
  const flip = pose.facing === 1 || pose.facing === 2 ? -1 : 1;
  const px = (x: number, y: number, w: number, h: number, c: string) => {
    ctx.fillStyle = c;
    ctx.fillRect(x, y, w, h);
  };

  ctx.save();
  ctx.translate(Math.round(sx), Math.round(sy));
  ctx.scale(scale, scale);

  // Shadow + selection ring.
  ctx.fillStyle = "rgba(0,0,0,0.22)";
  ctx.beginPath();
  ctx.ellipse(0, 0, 12, 5, 0, 0, Math.PI * 2);
  ctx.fill();
  if (selected) {
    ctx.strokeStyle = "#ffd84a";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, 0, 14, 6.5, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  ctx.scale(flip, 1);
  const lift = pose.seated ? -12 : 0;
  const step = pose.walking ? Math.sin(pose.t / 90) : 0;
  const bob = pose.walking ? Math.abs(step) * -1.5 : 0;
  ctx.translate(0, lift + bob);

  const pants = look.pants;
  const shirt = look.shirt;
  const skin = look.skin;
  const shirtDark = shade(shirt, -0.12);

  // Legs
  if (pose.seated) {
    px(-6, -8, 13, 5, pants);
    px(3, -8, 5, 10, shade(pants, -0.1));
    px(3, 1, 6, 3, "#222");
  } else {
    const l = Math.round(step * 3);
    px(-6, -18 - Math.max(0, l), 5, 18 + Math.min(0, -l) + (l > 0 ? 0 : 0), pants);
    px(1, -18 - Math.max(0, -l), 5, 18, shade(pants, -0.1));
    px(-7, -3 - Math.max(0, l), 6, 3, "#222");
    px(1, -3 - Math.max(0, -l), 6, 3, "#222");
  }

  // Torso
  px(-7, -36, 14, 19, shirt);
  px(1, -36, 6, 19, shirtDark);
  px(-7, -20, 14, 3, shade(pants, 0.05));

  // Arms
  const swing = pose.walking ? Math.round(step * 3) : 0;
  const typeBob = pose.typing ? (Math.floor(pose.t / 120) % 2 ? -1 : 1) : 0;
  if (pose.typing || pose.holdingCup) {
    // Forearm forward.
    px(-9, -35, 3, 10, shirtDark);
    px(-9, -26 + typeBob, 3, 3, skin);
    px(6, -35, 3, 8, shirtDark);
    px(6, -28, 7, 3, shirtDark);
    px(12, -29 - typeBob, 3, 3, skin);
    if (pose.holdingCup) {
      px(12, -35, 5, 6, "#fafafa");
      px(12, -35, 5, 1, "#6b3e1e");
    }
  } else {
    px(-9, -35 + swing, 3, 13, shirtDark);
    px(-9, -23 + swing, 3, 3, skin);
    px(6, -35 - swing, 3, 13, shirt);
    px(6, -23 - swing, 3, 3, skin);
  }

  // Head
  px(-6, -38, 11, 3, shade(skin, -0.08)); // neck
  px(-7, -51, 14, 14, skin);
  px(3, -51, 4, 14, shade(skin, -0.06));
  const hair = look.hair;
  if (front) {
    // Face towards the right (mirrored for left-facing).
    px(1, -45, 2, 3, "#1b1b1b");
    px(5, -45, 2, 3, "#1b1b1b");
    px(2, -40, 4, 1, shade(skin, -0.3));
    switch (look.hairStyle) {
      case 0:
        px(-8, -54, 16, 5, hair);
        px(-8, -50, 4, 6, hair);
        break;
      case 1:
        px(-8, -54, 16, 5, hair);
        px(-8, -50, 5, 14, hair);
        break;
      case 2:
        px(-8, -53, 16, 4, hair);
        for (let i = -7; i < 7; i += 4) px(i, -57, 3, 4, hair);
        px(-8, -50, 3, 4, hair);
        break;
      case 3:
        px(-7, -53, 14, 3, hair);
        break;
    }
  } else {
    px(-8, -54, 16, 5, hair);
    px(-8, -50, 16, look.hairStyle === 1 ? 14 : look.hairStyle === 3 ? 4 : 9, hair);
  }
  ctx.restore();
}

/* ------------------------------------------------------------ overlays */

export function drawNameTag(ctx: Ctx, x: number, y: number, name: string, dot: string, scale: number): void {
  ctx.save();
  ctx.font = `bold ${Math.round(9 * Math.max(1, scale))}px ui-monospace, monospace`;
  const w = ctx.measureText(name).width + 18;
  const h = 14 * Math.max(1, scale);
  ctx.fillStyle = "rgba(20,24,30,0.72)";
  roundRect(ctx, x - w / 2, y, w, h, 4);
  ctx.fill();
  ctx.fillStyle = dot;
  ctx.beginPath();
  ctx.arc(x - w / 2 + 7, y + h / 2, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(name, x - w / 2 + 13, y + h / 2 + 0.5);
  ctx.restore();
}

export function drawThought(ctx: Ctx, x: number, y: number, t: number, scale: number): void {
  const s = Math.max(1, scale);
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.strokeStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.arc(x - 4 * s, y + 8 * s, 2 * s, 0, Math.PI * 2);
  ctx.fill();
  roundRect(ctx, x - 12 * s, y - 8 * s, 24 * s, 12 * s, 6 * s);
  ctx.fill();
  ctx.stroke();
  const n = Math.floor(t / 350) % 4;
  ctx.fillStyle = "#444";
  for (let i = 0; i < n; i++) {
    ctx.beginPath();
    ctx.arc(x - 6 * s + i * 6 * s, y - 2 * s, 1.6 * s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawAlert(ctx: Ctx, x: number, y: number, t: number, scale: number): void {
  const s = Math.max(1, scale);
  const jump = Math.abs(Math.sin(t / 250)) * 4 * s;
  ctx.save();
  ctx.fillStyle = "#ffcc00";
  ctx.strokeStyle = "#8a6d00";
  ctx.beginPath();
  ctx.arc(x, y - jump, 8 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#3a2d00";
  ctx.font = `bold ${Math.round(12 * s)}px sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("!", x, y - jump + 1);
  ctx.restore();
}

/** Habbo-style chat bubble: name in bold, then the text, on one line. */
export function drawChatBubble(ctx: Ctx, x: number, y: number, name: string, text: string, color: string, alpha: number, scale: number): void {
  const s = Math.max(1, scale);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `${Math.round(10 * s)}px ui-sans-serif, system-ui, sans-serif`;
  const body = text.length > 64 ? `${text.slice(0, 61)}...` : text;
  ctx.font = `bold ${Math.round(10 * s)}px ui-sans-serif, system-ui, sans-serif`;
  const nameW = ctx.measureText(`${name}: `).width;
  ctx.font = `${Math.round(10 * s)}px ui-sans-serif, system-ui, sans-serif`;
  const w = nameW + ctx.measureText(body).width + 16 * s;
  const h = 18 * s;
  const left = x - w / 2;
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#333";
  ctx.lineWidth = 1;
  roundRect(ctx, left, y - h, w, h, 5 * s);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.fillRect(left + 3 * s, y - h + 3 * s, 3 * s, h - 6 * s);
  ctx.beginPath();
  ctx.moveTo(x - 4 * s, y);
  ctx.lineTo(x, y + 5 * s);
  ctx.lineTo(x + 4 * s, y);
  ctx.fillStyle = "#fff";
  ctx.fill();
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  ctx.fillStyle = "#111";
  ctx.font = `bold ${Math.round(10 * s)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(`${name}:`, left + 9 * s, y - h / 2 + 0.5);
  ctx.font = `${Math.round(10 * s)}px ui-sans-serif, system-ui, sans-serif`;
  ctx.fillText(body, left + 9 * s + nameW, y - h / 2 + 0.5);
  ctx.restore();
}

export function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export { TILE_H, TILE_W };
