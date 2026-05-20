# Mars Rover Agent

A fully-autonomous rover completes science missions on Mars. Tool calls, battery, weather, and time pressure are constraints.

<img width="1472" height="802" alt="image" src="https://github.com/user-attachments/assets/71be29aa-32d8-47c4-9d24-3f294528cc45" />


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

## Design choices

### **Observations**
Each turn the agent gets one JSON snapshot (no camera image): pose, battery, weather, `visibility_m`, inventory, mission goal/hint, and a `visible` list of landmarks currently in frame. Vision is deliberately limited and mostly text-based:

- **Automatic FOV** — Landmarks appear in `visible` only if they are within **±90° of heading** and closer than **`visibility_m`** (clear ≈ 80 m, dusty ≈ 35 m, storm ≈ 15 m). Each entry has `bearing_deg`, `range_m`, and tags; rock minerals appear only after a `scan()`.
- **`look()` (1% battery)** — Opt-in mast-camera report: same FOV rules as above, formatted as a readable landmark list (heading, weather, ranges). Still **no image**; use this when you want a clearer picture than the compact `visible` array.
- **`photograph()` (1% battery)** — Stricter than `look()`: target must be **≤ 40 m** and within **±45° of heading** (aim with `aim_mast` / `turn` first). On success the world records the photo; a **PNG** is attached to the tool result only when the **viewer is open** (3 s capture timeout via WebSocket). Headless runs still complete photograph objectives from range/angle checks alone.
- **History compression** — On long runs, older turns keep a digest of observations (`visible_count`), so distant FOV detail can fade unless stored in `note()`.

### **Action space** 
11 named tools (`move`, `turn`, `scan`, …) with server-side validation and battery/sol costs. That matches how LLM agents are deployed, makes failures legible (“must scan first”, “off-frame”), and ties mission steps to explicit tools. `note()` is free so the agent can keep a plan across long runs and decide what is important memory to store.

### **What worked**
Beacon-without giving the actual bearings and coordinates produced sensible explore-and-refine behavior from the agent.
Agent is aware that distinct samples have to be collected and would continue to proceed with the mission if similar sample types were scanned.
Compressing old chat history (`history.ts`) let full missions finish without blowing context. 
Server-authoritative world means the mission runs headless and works without the frontend if required.

### **What didn’t**
Very long runs still lose detail in compressed history.
 `photograph` images only arrive when the viewer is open (3s timeout).
 Haiku sometimes loops on bad moves and doesnt consider battery depletion, opus/sonnet are more reliable for the full 5-step chain.


