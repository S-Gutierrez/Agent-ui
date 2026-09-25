// 2:1 isometric projection (the classic Habbo look): +x goes to the lower
// right of the screen, +y to the lower left.

export const TILE_W = 64;
export const TILE_H = 32;
export const WALL_H = 96;

export interface Point {
  x: number;
  y: number;
}

export class Camera {
  scale = 1;
  offsetX = 0;
  offsetY = 0;

  /** Tile coords (can be fractional) -> canvas pixels (tile centre). */
  toScreen(tx: number, ty: number, z = 0): Point {
    return {
      x: this.offsetX + ((tx - ty) * TILE_W) / 2 * this.scale,
      y: this.offsetY + (((tx + ty) * TILE_H) / 2 + TILE_H / 2 - z) * this.scale,
    };
  }

  /** Canvas pixels -> fractional tile coords on the floor. */
  toTile(sx: number, sy: number): Point {
    const px = (sx - this.offsetX) / this.scale;
    const py = (sy - this.offsetY) / this.scale - TILE_H / 2;
    return {
      x: py / TILE_H + px / TILE_W,
      y: py / TILE_H - px / TILE_W,
    };
  }

  /** Centre and scale a width x height room inside a viewport. */
  fit(width: number, height: number, viewW: number, viewH: number): void {
    const roomW = ((width + height) * TILE_W) / 2;
    const roomH = ((width + height) * TILE_H) / 2 + WALL_H;
    const s = Math.min(viewW / (roomW + 80), viewH / (roomH + 100));
    this.scale = Math.max(0.5, Math.min(2.5, Math.floor(s * 4) / 4 || 0.5));
    // Left-most point of the room is tile (0, height); right-most (width, 0).
    const minX = (-height * TILE_W) / 2;
    this.offsetX = viewW / 2 - (minX + roomW / 2) * this.scale;
    this.offsetY = (viewH - roomH * this.scale) / 2 + (WALL_H + 20) * this.scale;
  }
}
