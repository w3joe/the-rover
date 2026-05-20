import type { Tool } from '@anthropic-ai/sdk/resources/messages.js'
import type { MissionDef } from '@mars/shared'
import { describeObjective, objectiveHint } from '../world/mission.js'

export function buildSystemPrompt(mission: MissionDef): string {
  const objectiveList = mission.objectives
    .map((o, i) => `  ${i + 1}. ${describeObjective(o)}\n     Hint: ${objectiveHint(o)}`)
    .join('\n')

  return `You are an autonomous Mars rover running on battery power. Complete the mission below before the sol ends or your battery dies.

## Mission: ${mission.name}
Objectives (in order):
${objectiveList}

Call submit_mission_step() only after each objective's success criteria are met. The world validates them — if it rejects, keep working.

## Physics
- World is 200m × 200m. You start at base_station (x≈12, z≈12).
- Heading 0° = north (+z), 90° = east (+x), 180° = south, 270° = west.
- Sol has 540 minutes. Dawn ≈ minute 80, dusk ≈ minute 500.
- Battery recharges during daylight (peak ~0.8%/min). Night drains 0.05%/min.
- Dust storms cut solar recharge and visibility significantly.

## Observation cycle
Each turn you receive a JSON observation (battery, pose, beacon_ping_m, weather, visibility, mission.goal/hint, visible objects, inventory.samples and inventory.sample_minerals for distinct-mineral objectives). Make as many tool calls as needed, then the world advances and you receive a new observation.

## Tools & costs
- move(distance_m): 0.5%/m. Can be negative (reverse). Blocked by obstacles.
- turn(degrees): 0.1% per 90°. Positive = clockwise.
- aim_mast(pitch, yaw): free. pitch ±30°, yaw rotates rover heading.
- look(): 1%. Emulated mast-camera vision — structured list of landmarks in FOV (bearing, range, tags); no photograph.
- scan(target_id): 2%. Spectrometer on a rock ≤8m away. Required before sample.
- sample(target_id): 3%. Arm pickup ≤5m. Rock must be scanned first.
- photograph(target_id): 1%. Target must be ≤40m and within 45° of heading. Saves a mast POV frame from the operator viewer when connected.
- repair(target_id, action): 1–5%. Actions: assess, fix_coupling, fix_antenna.
- wait(minutes): passive. Recharges if daytime. Use during storms or to wait for dawn.
- note(text): free. Use this to record plans, measurements, and reasoning across turns.
- submit_mission_step(): validates and advances to next objective.

## Strategy tips
- Use note() liberally — it's free and keeps your plan visible across turns.
- The beacon only gives range (beacon_ping_m), not bearing. Navigate by reducing that number.
- Always scan a rock before approaching to sample — wasted trips are expensive.
- Watch battery carefully on long traversals. wait() near dusk if a storm is blocking solar.
- Photograph: get within 40m AND face the target (aim_mast or turn to align within 45°).
- Repair: pick up repair_tool first (near base_station), then drive to relay_tower.
- Return: start heading back well before dusk (minute 500). Distance ÷ 0.3 ≈ minutes to travel.`
}

export const TOOL_SCHEMAS: Tool[] = [
  {
    name: 'move',
    description: 'Drive the rover forward (positive) or backward (negative). Battery cost 0.5%/m.',
    input_schema: {
      type: 'object',
      properties: {
        distance_m: { type: 'number', description: 'Metres to move. Negative = reverse.' },
      },
      required: ['distance_m'],
    },
  },
  {
    name: 'turn',
    description: 'Rotate in place. Positive = clockwise (east). Battery cost 0.1% per 90°.',
    input_schema: {
      type: 'object',
      properties: {
        degrees: { type: 'number', description: 'Degrees to rotate. Positive = clockwise.' },
      },
      required: ['degrees'],
    },
  },
  {
    name: 'aim_mast',
    description: 'Adjust the mast camera. pitch ±30° (positive = up). yaw rotates the rover heading.',
    input_schema: {
      type: 'object',
      properties: {
        pitch: { type: 'number', description: 'Mast pitch in degrees. Range -30 to 30.' },
        yaw: { type: 'number', description: 'Optional heading change in degrees. Default 0.' },
      },
      required: ['pitch'],
    },
  },
  {
    name: 'look',
    description: 'Emulated mast-camera vision: returns landmarks in FOV with bearing, range, and tags (no image). Cost 1%.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'scan',
    description: 'Run spectrometer on a rock to identify its mineral type. Must be ≤8m away. Cost 2%.',
    input_schema: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: 'ID of the rock landmark.' },
      },
      required: ['target_id'],
    },
  },
  {
    name: 'sample',
    description: 'Pick up a rock sample. Must be scanned first and within 5m. Cost 3%.',
    input_schema: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: 'ID of the rock landmark.' },
      },
      required: ['target_id'],
    },
  },
  {
    name: 'photograph',
    description: 'Photograph a landmark. Must be ≤40m away and within 45° of current heading. Captures mast POV from the live viewer. Cost 1%.',
    input_schema: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: 'ID of the landmark to photograph.' },
      },
      required: ['target_id'],
    },
  },
  {
    name: 'repair',
    description: 'Repair the relay tower. Must be ≤4m away. Actions: assess → fix_coupling → fix_antenna.',
    input_schema: {
      type: 'object',
      properties: {
        target_id: { type: 'string', description: 'Landmark ID (relay_tower).' },
        action: {
          type: 'string',
          enum: ['assess', 'fix_coupling', 'fix_antenna'],
          description: 'Repair action to perform.',
        },
      },
      required: ['target_id', 'action'],
    },
  },
  {
    name: 'wait',
    description: 'Wait in place for N minutes. Recharges battery during daylight. Max 60 min per call.',
    input_schema: {
      type: 'object',
      properties: {
        minutes: { type: 'number', description: 'Minutes to wait (1–60).' },
      },
      required: ['minutes'],
    },
  },
  {
    name: 'note',
    description: 'Write a free-form note to your log. Free — no battery cost. Use for plans and observations.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Note text.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'submit_mission_step',
    description: 'Declare the current mission objective complete. The world validates success criteria.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
]
