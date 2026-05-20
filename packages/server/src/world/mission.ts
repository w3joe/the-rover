import type {
  Landmark,
  MissionDef,
  MissionStatus,
  Objective,
  RoverState,
  WorldConditions,
} from '@mars/shared'

// ── Objective handlers ─────────────────────────────────────────────────────

interface ObjectiveCheck {
  complete: boolean
  reason: string
}

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z)

interface ObjectiveHandler<O extends Objective> {
  describe(o: O): string
  hint(o: O): string
  check(o: O, rover: RoverState, landmarks: Landmark[]): ObjectiveCheck
}

const reachHandler: ObjectiveHandler<Extract<Objective, { kind: 'reach' }>> = {
  describe: o => `Reach ${o.landmarkId} (within ${o.radiusM}m).`,
  hint: o =>
    o.landmarkId === 'beacon_A'
      ? 'beacon_A is not in the visible list — navigate by reducing beacon_ping_m.'
      : `Drive to ${o.landmarkId}; use look() to confirm bearing.`,
  check: (o, rover, landmarks) => {
    const lm = landmarks.find(l => l.id === o.landmarkId)
    if (!lm) return { complete: false, reason: `${o.landmarkId} not found.` }
    const d = dist(rover.pose, lm)
    if (d <= o.radiusM) return { complete: true, reason: `Reached ${o.landmarkId} (${d.toFixed(1)}m away).` }
    return { complete: false, reason: `${d.toFixed(1)}m from ${o.landmarkId}, need ≤${o.radiusM}m.` }
  },
}

const collectHandler: ObjectiveHandler<Extract<Objective, { kind: 'collect_samples' }>> = {
  describe: o =>
    `Collect ${o.count} rock sample${o.count === 1 ? '' : 's'}${o.distinctMinerals ? ' of distinct mineral types' : ''}.`,
  hint: () => 'Scan a rock before approaching to sample — wasted trips drain battery.',
  check: (o, rover, _landmarks) => {
    const collectedCount = rover.inventory.samples.length
    if (o.distinctMinerals) {
      const minerals = new Set(
        rover.inventory.sampleMinerals.filter(m => m && m !== 'unknown'),
      )
      const distinct = minerals.size
      if (collectedCount >= o.count && distinct >= o.count) {
        return { complete: true, reason: `${o.count} distinct mineral samples collected.` }
      }
      return {
        complete: false,
        reason: `Have ${collectedCount} sample(s), ${distinct} distinct mineral type(s); need ${o.count} samples each a different mineral.`,
      }
    }
    if (collectedCount >= o.count) {
      return { complete: true, reason: `${collectedCount} samples collected.` }
    }
    return { complete: false, reason: `Have ${collectedCount} sample(s), need ${o.count}.` }
  },
}

const photographHandler: ObjectiveHandler<Extract<Objective, { kind: 'photograph' }>> = {
  describe: o => `Photograph ${o.landmarkId}.`,
  hint: o => `Get within 40m of ${o.landmarkId} and face it (within 45°) before photograph().`,
  check: (o, rover, landmarks) => {
    const lm = landmarks.find(l => l.id === o.landmarkId)
    if (lm?.photographed || rover.inventory.photos.includes(o.landmarkId)) {
      return { complete: true, reason: `${o.landmarkId} photographed.` }
    }
    return { complete: false, reason: `${o.landmarkId} not yet photographed.` }
  },
}

const repairHandler: ObjectiveHandler<Extract<Objective, { kind: 'repair' }>> = {
  describe: o => `Repair ${o.landmarkId}.`,
  hint: () => 'Drive within 3m of the repair_tool landmark to collect it, then at the relay: assess → fix_coupling → fix_antenna.',
  check: (o, _rover, landmarks) => {
    const lm = landmarks.find(l => l.id === o.landmarkId)
    if (!lm) return { complete: false, reason: `${o.landmarkId} not found.` }
    if (lm.repairStage === 'repaired') return { complete: true, reason: `${o.landmarkId} fully repaired.` }
    return { complete: false, reason: `${o.landmarkId} repair state: ${lm.repairStage ?? 'intact'}.` }
  },
}

const returnHandler: ObjectiveHandler<Extract<Objective, { kind: 'return_to_base' }>> = {
  describe: o => {
    const deadline = o.deadlineSolMinute != null
      ? ` before sol-minute ${o.deadlineSolMinute}`
      : ''
    return `Return to ${o.landmarkId} (within ${o.radiusM}m)${deadline}.`
  },
  hint: o =>
    `Distance ÷ 0.3 ≈ sol-minutes to travel. ${o.deadlineSolMinute != null ? `Start back well before minute ${o.deadlineSolMinute}.` : 'Watch battery on the traverse.'}`,
  check: (o, rover, landmarks) => {
    const lm = landmarks.find(l => l.id === o.landmarkId)
    if (!lm) return { complete: false, reason: `${o.landmarkId} not found.` }
    const d = dist(rover.pose, lm)
    if (d <= o.radiusM) return { complete: true, reason: `Returned to ${o.landmarkId} (${d.toFixed(1)}m away).` }
    return { complete: false, reason: `${d.toFixed(1)}m from ${o.landmarkId}, need ≤${o.radiusM}m.` }
  },
}

const HANDLERS = {
  reach: reachHandler,
  collect_samples: collectHandler,
  photograph: photographHandler,
  repair: repairHandler,
  return_to_base: returnHandler,
}

// Type-safe dispatch: each handler narrows its own objective variant.
export function describeObjective(o: Objective): string {
  return (HANDLERS[o.kind].describe as (x: Objective) => string)(o)
}

export function objectiveHint(o: Objective): string {
  return (HANDLERS[o.kind].hint as (x: Objective) => string)(o)
}

export function checkObjective(
  o: Objective,
  rover: RoverState,
  landmarks: Landmark[],
): ObjectiveCheck {
  return (HANDLERS[o.kind].check as (x: Objective, r: RoverState, l: Landmark[]) => ObjectiveCheck)(
    o, rover, landmarks,
  )
}

// ── Mission lifecycle ──────────────────────────────────────────────────────

export function initMissionStatus(mission: MissionDef): MissionStatus {
  return {
    name: mission.name,
    objectiveLabels: mission.objectives.map(describeObjective),
    goal: mission.objectives.length > 0 ? describeObjective(mission.objectives[0]) : 'No objectives.',
    current: 0,
    completed: [],
    complete: mission.objectives.length === 0,
    failed: false,
  }
}

export function advanceMission(status: MissionStatus, objectives: Objective[]): MissionStatus {
  const nextIndex = status.current + 1
  const completed = [...status.completed, status.current]
  if (nextIndex >= objectives.length) {
    return { ...status, completed, complete: true }
  }
  return {
    ...status,
    completed,
    current: nextIndex,
    goal: describeObjective(objectives[nextIndex]),
  }
}

export function checkFailConditions(rover: RoverState): { failed: boolean; reason: string } {
  if (rover.battery_pct <= 0) return { failed: true, reason: 'Battery depleted — rover immobilised.' }
  if (rover.sol_minute >= 540 && rover.sol > 1) return { failed: true, reason: 'Sol ended without completing mission.' }
  return { failed: false, reason: '' }
}

// ── Presets ────────────────────────────────────────────────────────────────

export const DEFAULT_CONDITIONS: WorldConditions = {
  seed: 42,
  startBatteryPct: 100,
  startSolMinute: 150,
  stormFrequency: 'normal',
}

const STANDARD_OBJECTIVES: Objective[] = [
  { kind: 'reach', landmarkId: 'beacon_A', radiusM: 5 },
  { kind: 'collect_samples', count: 3, distinctMinerals: true },
  { kind: 'photograph', landmarkId: 'olympus_spire' },
  { kind: 'repair', landmarkId: 'relay_tower' },
  { kind: 'return_to_base', landmarkId: 'base_station', radiusM: 10, deadlineSolMinute: 500 },
]

export const PRESET_MISSIONS: MissionDef[] = [
  {
    name: 'Distinct Samples',
    objectives: [{ kind: 'collect_samples', count: 3, distinctMinerals: true }],
    conditions: { ...DEFAULT_CONDITIONS },
  },
  {
    name: 'Beacon Reach',
    objectives: [{ kind: 'reach', landmarkId: 'beacon_A', radiusM: 5 }],
    conditions: { ...DEFAULT_CONDITIONS },
  },
  {
    name: 'Spire Recon',
    objectives: [
      { kind: 'photograph', landmarkId: 'olympus_spire' },
      { kind: 'return_to_base', landmarkId: 'base_station', radiusM: 10 },
    ],
    conditions: { ...DEFAULT_CONDITIONS },
  },
  {
    name: 'Endurance Run',
    objectives: STANDARD_OBJECTIVES,
    conditions: { seed: 42, startBatteryPct: 70, startSolMinute: 380, stormFrequency: 'high' },
  },
]
