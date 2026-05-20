# Mars Rover Agent

A fully-autonomous rover completes science missions on Mars. Tool calls, battery, weather, and time pressure are constraints.

## Run it

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

**Split terminals:** `ANTHROPIC_API_KEY=... pnpm mission` and `pnpm viewer`

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

## Design choices

**Observations**
Each turn the agent gets one JSON snapshot: pose, battery, weather, inventory, mission goal/hint, landmarks in FOV (`bearing_deg`, `range_m`), plus `known_landmarks` for things it has seen before. We avoided sending a camera image every step (too many tokens, unstable). Vision is opt-in: `look()` returns a text FOV report; `photograph()` can attach a PNG from the viewer when connected. `beacon_A` is range-only (`beacon_ping_m`) so navigation is real triangulation, not GPS.

**Action space** 
11 named tools (`move`, `turn`, `scan`, …) with server-side validation and battery/sol costs. That matches how LLM agents are deployed, makes failures legible (“must scan first”, “off-frame”), and ties mission steps to explicit tools. `note()` is free so the agent can keep a plan across long runs.

**What worked**
Beacon-without-bearing produced sensible explore-and-refine behavior; scan-before-sample cut wasted drives; compressing old chat history (`history.ts`) let full missions finish without blowing context; server-authoritative world means the mission runs headless.

**What didn’t** — Very long runs still lose detail in compressed history; `photograph` images only arrive when the viewer is open (3s timeout); haiku sometimes loops on bad moves and doesnt consider battery depletion, opus/sonnet are more reliable for the full 5-step chain.

## Agent tools

`move` · `turn` · `aim_mast` · `look` · `scan` · `sample` · `photograph` · `repair` · `wait` · `note` · `submit_mission_step`

## World

- One sol ≈ 10 real minutes (540 sol-minutes). Dawn ~80, dusk ~500.
- Daylight recharges battery; night and dust storms drain it and cut visibility.
- Depleted battery or unfinished mission at sol end = failure.
