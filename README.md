# Mars Rover Agent

A fully-autonomous rover completes science missions on Mars. Tool calls, battery, weather, and time pressure are constraints.

<img width="1472" height="802" alt="image" src="https://github.com/user-attachments/assets/71be29aa-32d8-47c4-9d24-3f294528cc45" />

<iframe width="1400" height="800" src="https://www.youtube.com/embed/M2FaJc-2xcQ?si=0-RuWyk-TqF8WAy5" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>

## Run command

```bash
pnpm install
ANTHROPIC_API_KEY=sk-... pnpm dev          # sonnet (default)
# ROVER_MODEL=haiku|sonnet|opus  —  pnpm dev haiku  /  pnpm dev:opus
```

| Service | URL |
|---------|-----|
| Agent (WebSocket) | `ws://localhost:3001` |
| Viewer | http://localhost:5173 |

1. Open the viewer and wait for **Connected to agent server**
2. Pick a preset (or build a custom mission) and click **Launch**

### Tests

```bash
pnpm test
```

Runs a headless integration test: a scripted navigator uses the same tool dispatch path as the LLM agent and completes the **Beacon Reach** preset.

## Agent tools

`move` · `turn` · `aim_mast` · `look` · `scan` · `sample` · `photograph` · `repair` · `wait` · `note` · `submit_mission_step`

## World

- One sol ≈ 10 real minutes (540 sol-minutes). Dawn ~80, dusk ~500.
- Daylight recharges battery; night and dust storms drain it and cut visibility.
- Depleted battery or unfinished mission at sol end = failure.

## Full mission (5 steps)

| # | Goal | Constraint |
|---|------|------------|
| 1 | Reach `beacon_A` | `beacon_ping_m` only — no bearing |
| 2 | 3 rock samples (distinct minerals) | Scan first; sample ≤ 5 m |
| 3 | Photograph `olympus_spire` | ≤ 40 m, within 45° of heading |
| 4 | Repair `relay_tower` | Pick up `repair_tool` near base; assess → fix_coupling → fix_antenna |
| 5 | Return to `base_station` | Before sol minute 500 |

Presets include shorter drills; **Endurance Run** is the full chain (harder start: 70% battery, sol 380, more storms).

## Example turn

**Observation** (JSON each turn): pose, battery, weather, `beacon_ping_m`, `visible` landmarks (bearing + range), inventory, current `mission.goal` / `hint`.

**Tools** (one turn): e.g. `note` → `turn(15)` → `move(20)` → `look()`

**Results:** world text (`Moved 20.0m. Battery -10.0%.`, FOV landmark list from `look()`, etc.). The viewer **Agent log** shows each turn; WebSocket messages on port 3001 have the full trace.

## Design

The rover is built like a production agent loop: The model only proposes validated tool calls, and every turn is a small JSON observation. That keeps runs debuggable in the viewer or headless, makes mission progress auditable (`submit_mission_step` gates objectives), and mirrors how I would deploy a real ops agent with discrete actions, explicit costs, legible failures.

**Observations** — One snapshot per turn (pose, battery, weather, `visibility_m`, inventory, mission goal/hint, `visible` landmarks). Vision is deliberately text-first so the agent reasons over structure, not screenshots:

- **Automatic FOV** — Landmarks appear in `visible` only within **±90° of heading** and **`visibility_m`** (clear ≈ 80 m, dusty ≈ 35 m, storm ≈ 15 m). Rock minerals appear only after `scan()`.
- **`look()`** — Same FOV rules, formatted for reading; still no image (1% battery).
- **`photograph()`** — Tighter gate (≤ 40 m, ±45°); server records success for objectives; PNG only when the viewer is connected (3 s capture timeout).
- **History compression** — Older turns keep a digest of observations (`visible_count`); the agent is expected to use free `note()` for anything that must survive compression.

**Action space** — Eleven named tools with server-side validation and battery/sol costs. Named tools match how LLM agents are actually wired, make failures actionable (“must scan first”, “off-frame”), and tie each mission step to an explicit action.

## **What worked**

- Beacon distance without bearing/coordinates produced explore-and-refine behavior instead of cheating coordinates.
- The model generally keeps sampling after duplicate mineral scans when distinct types are required.
- `history.ts` compression let full missions finish without blowing context.
- Server-authoritative world runs headless; the viewer is optional.

## **Limitations and next steps**

| Limitation | Next step |
|------------|-----------|
| Compressed history drops fine-grained FOV detail on very long runs | Tier summaries (objective-level digests) or pin `note()` entries into the compressed window |
| `photograph` PNGs only when the viewer is open | Server-side POV render fallback (Puppeteer or shared headless Three.js) so artifacts always attach |
| Haiku sometimes loops on bad moves and ignores battery on the full chain | Smaller-model prompt tuning, a battery “panic” hint in observations, or a lightweight planner pass before tool selection |
