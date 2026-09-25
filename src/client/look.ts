import { hashString } from "../shared/placement.ts";
import type { AvatarLook } from "../shared/types.ts";

const SKIN = ["#f3d2b3", "#e8b98f", "#c68b5e", "#9c6a43", "#6e4a2f", "#f7e0cf"];
const HAIR = ["#2b1d14", "#5a3a22", "#a8652a", "#e3c27a", "#1d1d1d", "#b33a3a", "#6b6f7a", "#3c5fa8"];
const SHIRT = ["#d9534f", "#4a90d9", "#5cb85c", "#f0ad4e", "#9b59b6", "#1abc9c", "#e67e22", "#34495e", "#e84393"];
const PANTS = ["#2c3e50", "#3b3b3b", "#4a6fa5", "#6d4c41", "#556b2f"];

/** A stable, pseudo-random look for an agent id. */
export function lookFor(id: string, given?: AvatarLook): AvatarLook {
  if (given) return given;
  const h = hashString(id);
  const at = <T>(xs: T[], shift: number) => xs[(h >>> shift) % xs.length]!;
  return {
    skin: at(SKIN, 0),
    hair: at(HAIR, 5),
    shirt: at(SHIRT, 10),
    pants: at(PANTS, 15),
    hairStyle: ((h >>> 20) % 4) as AvatarLook["hairStyle"],
  };
}

export const BOSS_LOOK: AvatarLook = { skin: "#f0c8a0", hair: "#1d1d1d", shirt: "#222831", pants: "#222831", hairStyle: 0 };
