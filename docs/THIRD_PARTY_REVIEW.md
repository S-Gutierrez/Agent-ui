# Third-party review: Habbo-style clients

Before building the office UI we reviewed popular open-source Habbo-style web
clients and renderers, to decide what (if anything) could be reused. The
clones were shallow (`git clone --depth 1`). They were inspected statically:
no `npm install`, and none of their code was executed.

| Repository | License | Last commit (HEAD) | Verdict |
| --- | --- | --- | --- |
| billsonnn/nitro-renderer (TS, PixiJS 6.5) | GPL-3.0 | 2026-02 | Clean, but copyleft and tightly coupled to Habbo asset bundles. **Ideas only.** |
| billsonnn/nitro-react (React client) | **None** | 2026-02 | No license, and ships around 400 Habbo UI images. **Do not copy.** |
| jankuss/shroom (TS, PixiJS 5) | LGPL-3.0-or-later | 2022-12 (unmaintained) | Embeds Sulake avatar game data, and its dependencies are outdated with known CVEs (axios 0.21, jsdom 16, ws 7...). **Ideas only.** |
| Kozennnn/scuti-renderer (TS, PixiJS 7) | **None** | 2024-01 | Small and clean, but all rights reserved. **Ideas only.** |

## Findings

- **No malware indicators were found:**
  - no `preinstall`/`postinstall` scripts
  - no `eval`/`new Function`
  - no obfuscated or minified committed JS
  - no hard-coded tokens or unexpected hosts
  - lockfiles resolve to the public npm/yarn registries (one e2e-only git dependency in shroom)
- **Intellectual property is the main risk.** Habbo sprites, figure data,
  furniture, UI images, `.nitro` and `.swf` bundles are © Sulake. Several repos
  embed them or depend on them. None of them may be copied into this project.
- **Licensing:** GPL-3.0 code would force this whole project to be GPL.
  Unlicensed repositories grant no rights at all.
- **Pathfinding:** none of the clients implement it (it runs on the server in
  Habbo emulators), so it had to be written anyway.

## Decision

**No code or assets were copied.** Agent Office has its own renderer (Canvas
2D, no runtime dependencies), and all art is drawn procedurally. We borrowed
only general, non-copyrightable ideas:

1. 2:1 isometric projection (`screenX = (x − y)·W/2`, `screenY = (x + y)·H/2`).
2. Painter's-algorithm depth sorting by `x + y`, with small per-layer offsets.
3. Tile-grid rooms with walls on the two back edges.
4. Habbo-style chat bubbles (name in bold, then the message).
