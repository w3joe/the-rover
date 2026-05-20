import {
  DEFAULT_SPEED_MULTIPLIER,
  type AgentObservation,
  type CollectedArtifact,
  type KnownLandmark,
  type Landmark,
  type MissionDef,
  type MissionReview,
  type MissionStatus,
  type Objective,
  type RoverState,
  type SpeedMultiplier,
  type VisibleObject,
  type WorldSnapshot,
} from '@mars/shared'
import {
  generateHeightmap,
  sampleHeight,
  WORLD_SIZE,
  HEIGHTMAP_SIZE,
  MAX_TRAVERSABLE_SLOPE,
} from './terrain.js'
import { LANDMARKS, MINERAL_TYPES } from './landmarks.js'
import {
  advanceMission,
  checkFailConditions,
  checkObjective,
  describeObjective,
  initMissionStatus,
  objectiveHint,
} from './mission.js'

export type DispatchResult = {
  text: string
  battery_cost: number
  imageBase64?: string
}

/** Ask the connected viewer to render mast POV from its Three.js scene (same as ◎ CAM). */
type POVCaptureFn = (snapshot: WorldSnapshot) => Promise<string | undefined>

const DAWN_MINUTE = 80
const DUSK_MINUTE = 500

// 600 real seconds per sol / 540 sol-minutes = 1.111 real seconds per sol-minute
const BASE_MS_PER_SOL_MIN = (600 / 540) * 1000
const MOVE_STEP_M = 0.25  // rover steps 0.25m at a time for smooth animation
const TOOL_PICKUP_RANGE_M = 3
const SAMPLE_ARM_RANGE_M = 5

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

export class World {
  private heights: number[]
  public landmarks: Landmark[]
  public rover: RoverState
  public mission: MissionStatus
  private knownLandmarkIds = new Set<string>()
  private collectedArtifacts: CollectedArtifact[] = []
  private lastActionResult = 'Mission started. Good luck, rover.'
  private nextStormAt: number
  private stormEndsAt = 0

  private paused = false
  private cancelled = false
  private resumeCallbacks: Array<() => void> = []
  private onStep?: () => void
  public speedMultiplier: SpeedMultiplier = DEFAULT_SPEED_MULTIPLIER

  constructor(
    private missionDef: MissionDef,
    private povCapture?: POVCaptureFn,
  ) {
    const conditions = missionDef.conditions
    this.heights = generateHeightmap(conditions.seed)
    this.landmarks = structuredClone(LANDMARKS)
    this.nextStormAt = this.rollNextStorm(conditions.startSolMinute)

    const base = this.landmarkById('base_station')!
    this.rover = {
      pose: { x: base.x, y: this.terrainY(base.x, base.z), z: base.z, heading_deg: 0, mast_pitch_deg: 0 },
      battery_pct: conditions.startBatteryPct,
      sol: 1,
      sol_minute: conditions.startSolMinute,
      weather: 'clear',
      visibility_m: 80,
      inventory: { samples: [], sampleMinerals: [], photos: [], hasRepairTool: false },
    }
    this.mission = initMissionStatus(missionDef)
    this.knownLandmarkIds.add('base_station')
  }

  getMissionDef(): MissionDef {
    return this.missionDef
  }

  getMissionReview(steps: number, elapsed_ms: number): MissionReview {
    return {
      missionName: this.mission.name,
      steps,
      elapsed_ms,
      artifacts: [...this.collectedArtifacts],
    }
  }

  private recordArtifact(artifact: CollectedArtifact): void {
    this.collectedArtifacts.push(artifact)
  }

  private solStamp(): { sol: number; solMinute: number } {
    return { sol: this.rover.sol, solMinute: this.rover.sol_minute }
  }

  setStepCallback(cb: () => void): void {
    this.onStep = cb
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    const cbs = this.resumeCallbacks.splice(0)
    cbs.forEach(cb => cb())
  }

  isPaused(): boolean {
    return this.paused
  }

  cancel(): void {
    this.cancelled = true
    this.resume()
  }

  isCancelled(): boolean {
    return this.cancelled
  }

  setSpeed(multiplier: SpeedMultiplier): void {
    this.speedMultiplier = multiplier
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.paused) return
    await new Promise<void>(resolve => this.resumeCallbacks.push(resolve))
  }

  private terrainY(x: number, z: number): number {
    return sampleHeight(this.heights, x, z)
  }

  landmarkById(id: string): Landmark | undefined {
    return this.landmarks.find(l => l.id === id)
  }

  private dist(ax: number, az: number, bx: number, bz: number): number {
    return Math.hypot(ax - bx, az - bz)
  }

  private relativeBearing(tx: number, tz: number): number {
    const dx = tx - this.rover.pose.x
    const dz = tz - this.rover.pose.z
    const abs = ((Math.atan2(dx, dz) * 180) / Math.PI + 360) % 360
    let rel = abs - this.rover.pose.heading_deg
    if (rel > 180) rel -= 360
    if (rel < -180) rel += 360
    return rel
  }

  // Storm interval scales with the mission's storm frequency setting.
  private rollNextStorm(fromMinute: number): number {
    const freq = this.missionDef.conditions.stormFrequency
    if (freq === 'none') return Infinity
    const base = freq === 'low' ? 300 : freq === 'high' ? 60 : 120
    const spread = freq === 'low' ? 200 : freq === 'high' ? 100 : 150
    return fromMinute + base + Math.floor(Math.random() * spread)
  }

  private advanceTime(minutes: number): void {
    const r = this.rover
    r.sol_minute += minutes
    if (r.sol_minute >= 540) { r.sol_minute -= 540; r.sol++ }

    const isDaytime = r.sol_minute >= DAWN_MINUTE && r.sol_minute < DUSK_MINUTE
    const sunStrength = isDaytime
      ? Math.sin(((r.sol_minute - DAWN_MINUTE) / (DUSK_MINUTE - DAWN_MINUTE)) * Math.PI)
      : 0
    const weatherFactor = r.weather === 'storm' ? 0.05 : r.weather === 'dusty' ? 0.4 : 1.0

    if (isDaytime) {
      r.battery_pct = Math.min(100, r.battery_pct + sunStrength * weatherFactor * 0.8 * minutes)
    } else {
      r.battery_pct = Math.max(0, r.battery_pct - 0.05 * minutes)
    }

    if (r.sol_minute >= this.nextStormAt && r.weather === 'clear' && this.stormEndsAt === 0) {
      const roll = Math.random()
      if (roll < 0.4) {
        r.weather = 'storm'; r.visibility_m = 15
        this.stormEndsAt = r.sol_minute + 60 + Math.floor(Math.random() * 80)
      } else if (roll < 0.7) {
        r.weather = 'dusty'; r.visibility_m = 35
        this.stormEndsAt = r.sol_minute + 30 + Math.floor(Math.random() * 40)
      }
      this.nextStormAt = this.rollNextStorm(r.sol_minute)
    }

    if (this.stormEndsAt > 0 && r.sol_minute >= this.stormEndsAt) {
      r.weather = 'clear'; r.visibility_m = 80; this.stormEndsAt = 0
    }
  }

  private drainBattery(pct: number): void {
    this.rover.battery_pct = Math.max(0, this.rover.battery_pct - pct)
  }

  private getVisibleLandmarks(): VisibleObject[] {
    const { rover } = this
    const visible: VisibleObject[] = []
    for (const lm of this.landmarks) {
      if (lm.type === 'beacon') continue
      const d = this.dist(rover.pose.x, rover.pose.z, lm.x, lm.z)
      if (d > rover.visibility_m) continue
      const rel = this.relativeBearing(lm.x, lm.z)
      if (Math.abs(rel) > 90) continue
      this.knownLandmarkIds.add(lm.id)
      visible.push({
        id: lm.id, type: lm.type,
        bearing_deg: Math.round(rel),
        range_m: Math.round(d * 10) / 10,
        tags: lm.tags,
        mineral: lm.mineral && lm.mineral !== 'unknown' ? lm.mineral : undefined,
      })
    }
    return visible.sort((a, b) => a.range_m - b.range_m)
  }

  /** Text-only mast-camera report (no Puppeteer render). */
  private formatEmulatedVision(): string {
    const { rover } = this
    const visible = this.getVisibleLandmarks()
    const lines = [
      `Pose: heading ${Math.round(rover.pose.heading_deg)}°, mast pitch ${Math.round(rover.pose.mast_pitch_deg)}°`,
      `Environment: ${rover.weather}, visibility ${rover.visibility_m}m`,
      'FOV: ±90° from heading (beacon_A is radio-only; use beacon_ping_m for distance)',
      '',
    ]
    if (!visible.length) {
      lines.push('No landmarks detected in frame.')
    } else {
      lines.push('Landmarks in frame:')
      for (const v of visible) {
        const bearing =
          v.bearing_deg === 0
            ? 'dead ahead'
            : v.bearing_deg > 0
              ? `${v.bearing_deg}° right`
              : `${Math.abs(v.bearing_deg)}° left`
        const mineral = v.mineral ? `, mineral: ${v.mineral}` : ''
        lines.push(`  • ${v.id} (${v.type}) — ${bearing}, ${v.range_m}m — [${v.tags.join(', ')}]${mineral}`)
      }
    }
    return lines.join('\n')
  }

  private getKnownLandmarks(): KnownLandmark[] {
    return [...this.knownLandmarkIds]
      .map(id => this.landmarkById(id)!)
      .filter(Boolean)
      .map(lm => ({
        id: lm.id, type: lm.type,
        bearing_deg: Math.round(this.relativeBearing(lm.x, lm.z)),
        range_m: Math.round(this.dist(this.rover.pose.x, this.rover.pose.z, lm.x, lm.z) * 10) / 10,
      }))
  }

  private beaconRange(): number {
    const b = this.landmarkById('beacon_A')
    if (!b) return 0
    return Math.round(this.dist(this.rover.pose.x, this.rover.pose.z, b.x, b.z) * 10) / 10
  }

  getObservation(): AgentObservation {
    const { rover, mission } = this
    const objectives = this.missionDef.objectives
    const current = objectives[mission.current]
    return {
      sol: rover.sol,
      time: `${String(Math.floor(rover.sol_minute / 60)).padStart(2, '0')}:${String(rover.sol_minute % 60).padStart(2, '0')}`,
      battery_pct: Math.round(rover.battery_pct * 10) / 10,
      weather: rover.weather,
      visibility_m: rover.visibility_m,
      pose: {
        x: Math.round(rover.pose.x * 10) / 10,
        z: Math.round(rover.pose.z * 10) / 10,
        heading_deg: Math.round(rover.pose.heading_deg),
        mast_pitch_deg: Math.round(rover.pose.mast_pitch_deg),
      },
      beacon_ping_m: this.beaconRange(),
      inventory: {
        samples: rover.inventory.samples,
        sample_minerals: rover.inventory.sampleMinerals,
        photos: rover.inventory.photos,
        has_repair_tool: rover.inventory.hasRepairTool,
      },
      visible: this.getVisibleLandmarks(),
      known_landmarks: this.getKnownLandmarks(),
      last_action_result: this.lastActionResult,
      mission: {
        objective_index: mission.current,
        total: objectives.length,
        goal: current ? describeObjective(current) : 'All objectives complete.',
        hint: current ? objectiveHint(current) : '',
        remaining_goals: objectives.slice(mission.current + 1).map(describeObjective),
      },
    }
  }

  getSnapshot(): WorldSnapshot {
    return {
      rover: this.rover,
      landmarks: this.landmarks,
      mission: this.mission,
      heightmap: this.heights,
      heightmapSize: HEIGHTMAP_SIZE,
      worldSize: WORLD_SIZE,
      stepCount: 0,
      beaconRangeM: this.beaconRange(),
      paused: this.paused,
      speed: this.speedMultiplier,
    }
  }

  isComplete(): boolean {
    return this.mission.complete || this.mission.failed
  }

  async dispatch(name: string, input: Record<string, unknown>): Promise<DispatchResult> {
    if (this.cancelled) {
      return { text: 'Mission cancelled.', battery_cost: 0 }
    }

    const fail = checkFailConditions(this.rover)
    if (fail.failed) {
      this.mission = { ...this.mission, failed: true, failReason: fail.reason }
      return { text: `[FAIL] ${fail.reason}`, battery_cost: 0 }
    }

    let result: DispatchResult

    switch (name) {
      case 'move':               result = await this.toolMove(input); break
      case 'turn':               result = await this.toolTurn(input); break
      case 'aim_mast':           result = this.toolAimMast(input); break
      case 'look':               result = this.toolLook(); break
      case 'scan':               result = await this.toolScan(input); break
      case 'sample':             result = await this.toolSample(input); break
      case 'photograph':         result = await this.toolPhotograph(input); break
      case 'repair':             result = await this.toolRepair(input); break
      case 'wait':               result = await this.toolWait(input); break
      case 'note':               result = this.toolNote(input); break
      case 'submit_mission_step': result = this.toolSubmit(); break
      default:                   result = { text: `Unknown tool: ${name}`, battery_cost: 0 }
    }

    this.lastActionResult = result.text
    const failAfter = checkFailConditions(this.rover)
    // Do not mark failed after the final objective is already complete (e.g. low battery on last submit).
    if (failAfter.failed && !this.mission.complete) {
      this.mission = { ...this.mission, failed: true, failReason: failAfter.reason }
    }

    return result
  }

  // Auto-collect any tool landmark the rover has driven within range of.
  private collectNearbyTool(): string {
    for (const lm of this.landmarks) {
      if (lm.type !== 'tool' || this.rover.inventory.hasRepairTool) continue
      if (this.dist(this.rover.pose.x, this.rover.pose.z, lm.x, lm.z) <= TOOL_PICKUP_RANGE_M) {
        this.rover.inventory.hasRepairTool = true
        this.landmarks.splice(this.landmarks.indexOf(lm), 1)
        return ` Picked up ${lm.id}.`
      }
    }
    return ''
  }

  private async toolMove(input: Record<string, unknown>): Promise<DispatchResult> {
    const distance = Number(input.distance_m)
    if (isNaN(distance)) return { text: 'Invalid distance.', battery_cost: 0 }

    const rad = (this.rover.pose.heading_deg * Math.PI) / 180
    const nx = this.rover.pose.x + Math.sin(rad) * distance
    const nz = this.rover.pose.z + Math.cos(rad) * distance

    if (nx < 0 || nx > WORLD_SIZE || nz < 0 || nz > WORLD_SIZE) {
      return { text: `Boundary reached — cannot move ${Math.abs(distance)}m.`, battery_cost: 0 }
    }

    const startY = this.terrainY(this.rover.pose.x, this.rover.pose.z)
    const endY = this.terrainY(nx, nz)
    const horizDist = Math.max(0.01, Math.abs(distance))
    if (Math.abs(endY - startY) / horizDist > MAX_TRAVERSABLE_SLOPE) {
      return {
        text: `Terrain too steep ahead (Δ${(endY - startY).toFixed(1)}m over ${Math.abs(distance)}m). Try a different heading.`,
        battery_cost: 0,
      }
    }

    for (const lm of this.landmarks) {
      if (lm.type === 'crater' || lm.type === 'rock' || lm.type === 'relay' || lm.type === 'beacon') {
        if (this.dist(nx, nz, lm.x, lm.z) < lm.radius + 0.8) {
          return { text: `Blocked by ${lm.id} (bearing ${Math.round(this.relativeBearing(lm.x, lm.z))}°).`, battery_cost: 0 }
        }
      }
    }

    const totalSteps = Math.max(1, Math.ceil(Math.abs(distance) / MOVE_STEP_M))
    const stepDist = distance / totalSteps
    const stepDx = Math.sin(rad) * stepDist
    const stepDz = Math.cos(rad) * stepDist
    const stepBattery = Math.abs(stepDist) * 0.5
    const stepSolMin = Math.abs(stepDist) * 0.3
    const stepMs = stepSolMin * BASE_MS_PER_SOL_MIN / this.speedMultiplier

    for (let i = 0; i < totalSteps; i++) {
      await this.waitIfPaused()
      const prevY = this.rover.pose.y
      this.rover.pose.x += stepDx
      this.rover.pose.z += stepDz
      const nextY = this.terrainY(this.rover.pose.x, this.rover.pose.z)
      const stepHoriz = Math.hypot(stepDx, stepDz)
      if (stepHoriz > 0 && Math.abs(nextY - prevY) / stepHoriz > MAX_TRAVERSABLE_SLOPE) {
        this.rover.pose.x -= stepDx
        this.rover.pose.z -= stepDz
        this.rover.pose.y = prevY
        return {
          text: `Stopped — slope too steep (Δ${(nextY - prevY).toFixed(1)}m over ${stepHoriz.toFixed(1)}m).`,
          battery_cost: 0,
        }
      }
      this.rover.pose.y = nextY
      this.drainBattery(stepBattery)
      this.advanceTime(stepSolMin)
      this.onStep?.()
      if (i < totalSteps - 1) await sleep(stepMs)
    }

    const pickup = this.collectNearbyTool()
    const totalCost = Math.abs(distance) * 0.5
    return {
      text: `Moved ${distance > 0 ? 'forward' : 'backward'} ${Math.abs(distance)}m. Battery -${totalCost.toFixed(1)}%.${pickup}`,
      battery_cost: totalCost,
    }
  }

  private async toolTurn(input: Record<string, unknown>): Promise<DispatchResult> {
    const degrees = Number(input.degrees)
    if (isNaN(degrees)) return { text: 'Invalid degrees.', battery_cost: 0 }

    // Animate turn in 5° increments
    const totalSteps = Math.max(1, Math.ceil(Math.abs(degrees) / 5))
    const stepDeg = degrees / totalSteps
    const stepMs = (Math.abs(stepDeg) / 90) * 0.1 * BASE_MS_PER_SOL_MIN / this.speedMultiplier

    for (let i = 0; i < totalSteps; i++) {
      await this.waitIfPaused()
      this.rover.pose.heading_deg = ((this.rover.pose.heading_deg + stepDeg) % 360 + 360) % 360
      this.onStep?.()
      if (i < totalSteps - 1) await sleep(stepMs)
    }

    const cost = Math.abs(degrees) / 90 * 0.1
    this.drainBattery(cost)
    this.advanceTime(0.5)
    return { text: `Turned ${degrees}°. Now facing ${Math.round(this.rover.pose.heading_deg)}°. Battery -${cost.toFixed(2)}%.`, battery_cost: cost }
  }

  private toolAimMast(input: Record<string, unknown>): DispatchResult {
    const pitch = Number(input.pitch)
    const yaw = Number(input.yaw ?? 0)
    if (isNaN(pitch)) return { text: 'Invalid pitch.', battery_cost: 0 }
    this.rover.pose.mast_pitch_deg = Math.max(-30, Math.min(30, pitch))
    if (yaw !== 0) this.rover.pose.heading_deg = ((this.rover.pose.heading_deg + yaw) % 360 + 360) % 360
    this.onStep?.()
    return { text: `Mast: pitch=${this.rover.pose.mast_pitch_deg}°, heading=${Math.round(this.rover.pose.heading_deg)}°.`, battery_cost: 0 }
  }

  private toolLook(): DispatchResult {
    const cost = 1.0
    this.drainBattery(cost)
    this.onStep?.()
    return {
      text: `${this.formatEmulatedVision()}\nBattery -${cost}%.`,
      battery_cost: cost,
    }
  }

  private async toolScan(input: Record<string, unknown>): Promise<DispatchResult> {
    const id = String(input.target_id)
    const lm = this.landmarkById(id)
    if (!lm) return { text: `Unknown: ${id}.`, battery_cost: 0 }
    if (lm.type !== 'rock') return { text: `${id} is not a rock.`, battery_cost: 0 }
    const d = this.dist(this.rover.pose.x, this.rover.pose.z, lm.x, lm.z)
    if (d > 8) return { text: `Too far to scan ${id} (${d.toFixed(1)}m, need ≤8m).`, battery_cost: 0 }

    const cost = 2.0
    const solMin = 2
    this.drainBattery(cost)
    await sleep(solMin * BASE_MS_PER_SOL_MIN / this.speedMultiplier)
    this.advanceTime(solMin)
    lm.mineral = MINERAL_TYPES[id] ?? 'unknown'
    this.onStep?.()

    return { text: `Spectrometer: ${id} is ${lm.mineral}. Battery -${cost}%.`, battery_cost: cost }
  }

  private async toolSample(input: Record<string, unknown>): Promise<DispatchResult> {
    const id = String(input.target_id)
    const lm = this.landmarkById(id)
    if (!lm) return { text: `Unknown: ${id}.`, battery_cost: 0 }
    if (lm.type !== 'rock') return { text: `${id} is not a rock.`, battery_cost: 0 }
    if (this.rover.inventory.samples.includes(id)) return { text: `Already sampled ${id}.`, battery_cost: 0 }
    const d = this.dist(this.rover.pose.x, this.rover.pose.z, lm.x, lm.z)
    if (d > SAMPLE_ARM_RANGE_M) {
      return {
        text: `Arm out of range — ${id} is ${d.toFixed(1)}m (need ≤${SAMPLE_ARM_RANGE_M}m).`,
        battery_cost: 0,
      }
    }
    if (!lm.mineral || lm.mineral === 'unknown') return { text: `Must scan ${id} first.`, battery_cost: 0 }

    const cost = 3.0
    const solMin = 5
    this.drainBattery(cost)
    await sleep(solMin * BASE_MS_PER_SOL_MIN / this.speedMultiplier)
    this.advanceTime(solMin)
    this.rover.inventory.samples.push(id)
    this.rover.inventory.sampleMinerals.push(lm.mineral)
    this.recordArtifact({
      kind: 'sample',
      rockId: id,
      mineral: lm.mineral,
      tags: [...lm.tags],
      ...this.solStamp(),
    })
    this.landmarks.splice(this.landmarks.indexOf(lm), 1)
    this.onStep?.()

    return { text: `Sampled ${id} (${lm.mineral}). Total: ${this.rover.inventory.samples.length}. Battery -${cost}%.`, battery_cost: cost }
  }

  private async toolPhotograph(input: Record<string, unknown>): Promise<DispatchResult> {
    const id = String(input.target_id)
    const lm = this.landmarkById(id)
    if (!lm) return { text: `Unknown: ${id}.`, battery_cost: 0 }
    const d = this.dist(this.rover.pose.x, this.rover.pose.z, lm.x, lm.z)
    if (d > 40) return { text: `Too far (${d.toFixed(1)}m, need ≤40m).`, battery_cost: 0 }
    const relBearing = Math.abs(this.relativeBearing(lm.x, lm.z))
    if (relBearing > 45) return { text: `Off-frame (${relBearing.toFixed(0)}° off-center, need ≤45°).`, battery_cost: 0 }

    const cost = 1.0
    this.drainBattery(cost)

    let imageBase64: string | undefined
    if (this.povCapture) {
      try {
        imageBase64 = await this.povCapture(this.getSnapshot())
      } catch { /* non-fatal */ }
    }

    this.rover.inventory.photos.push(id)
    lm.photographed = true
    this.recordArtifact({
      kind: 'photograph',
      landmarkId: id,
      landmarkType: lm.type,
      imageBase64,
      ...this.solStamp(),
    })
    this.onStep?.()

    return { text: `Photographed ${id} (${d.toFixed(1)}m, ${relBearing.toFixed(0)}° offset). Battery -${cost}%.`, battery_cost: cost }
  }

  private async toolRepair(input: Record<string, unknown>): Promise<DispatchResult> {
    const id = String(input.target_id)
    const action = String(input.action)
    const lm = this.landmarkById(id)
    if (!lm) return { text: `Unknown: ${id}.`, battery_cost: 0 }
    if (lm.type !== 'relay') return { text: `${id} is not a relay.`, battery_cost: 0 }
    const d = this.dist(this.rover.pose.x, this.rover.pose.z, lm.x, lm.z)
    if (d > 4) return { text: `Too far (${d.toFixed(1)}m, need ≤4m).`, battery_cost: 0 }

    if (action === 'assess') {
      const cost = 1.0; const solMin = 3
      this.drainBattery(cost)
      await sleep(solMin * BASE_MS_PER_SOL_MIN / this.speedMultiplier)
      this.advanceTime(solMin)
      lm.repairStage = 'assessed'; lm.repairIssues = ['damaged_coupling', 'loose_antenna']
      this.recordArtifact({
        kind: 'repair',
        landmarkId: id,
        action: 'assessed',
        issues: [...lm.repairIssues],
        ...this.solStamp(),
      })
      this.onStep?.()
      return { text: `Damage assessed. Issues: damaged_coupling, loose_antenna. Battery -${cost}%.`, battery_cost: cost }
    }

    if (!this.rover.inventory.hasRepairTool) {
      return { text: 'Need repair_tool in inventory — drive over the repair_tool landmark to collect it.', battery_cost: 0 }
    }

    if (action === 'fix_coupling') {
      if (lm.repairStage !== 'assessed') return { text: 'Must assess first.', battery_cost: 0 }
      const cost = 5.0; const solMin = 10
      this.drainBattery(cost)
      await sleep(solMin * BASE_MS_PER_SOL_MIN / this.speedMultiplier)
      this.advanceTime(solMin)
      lm.repairStage = 'coupling_fixed'
      this.recordArtifact({
        kind: 'repair',
        landmarkId: id,
        action: 'coupling_fixed',
        ...this.solStamp(),
      })
      this.onStep?.()
      return { text: `Coupling fixed. Remaining: loose_antenna. Battery -${cost}%.`, battery_cost: cost }
    }

    if (action === 'fix_antenna') {
      if (lm.repairStage !== 'coupling_fixed') return { text: 'Must fix_coupling first.', battery_cost: 0 }
      const cost = 5.0; const solMin = 10
      this.drainBattery(cost)
      await sleep(solMin * BASE_MS_PER_SOL_MIN / this.speedMultiplier)
      this.advanceTime(solMin)
      lm.repairStage = 'repaired'; lm.tags = ['operational', 'comms']
      this.recordArtifact({
        kind: 'repair',
        landmarkId: id,
        action: 'repaired',
        ...this.solStamp(),
      })
      this.onStep?.()
      return { text: `Antenna secured. Relay fully operational! Battery -${cost}%.`, battery_cost: cost }
    }

    return { text: `Unknown action "${action}". Valid: assess, fix_coupling, fix_antenna.`, battery_cost: 0 }
  }

  private async toolWait(input: Record<string, unknown>): Promise<DispatchResult> {
    const minutes = Math.min(60, Math.max(1, Number(input.minutes)))
    if (isNaN(minutes)) return { text: 'Invalid minutes.', battery_cost: 0 }

    for (let m = 0; m < minutes; m++) {
      await this.waitIfPaused()
      this.advanceTime(1)
      this.onStep?.()
      await sleep(BASE_MS_PER_SOL_MIN / this.speedMultiplier)
    }

    const isDaytime = this.rover.sol_minute >= DAWN_MINUTE && this.rover.sol_minute < DUSK_MINUTE
    return {
      text: `Waited ${minutes} sol-min. Battery: ${this.rover.battery_pct.toFixed(1)}%. Weather: ${this.rover.weather}. ${isDaytime ? 'Charged.' : 'Night.'}`,
      battery_cost: 0,
    }
  }

  private toolNote(input: Record<string, unknown>): DispatchResult {
    void input
    return { text: 'Note recorded.', battery_cost: 0 }
  }

  private toolSubmit(): DispatchResult {
    const objectives = this.missionDef.objectives
    if (this.mission.current >= objectives.length) {
      return { text: 'Mission already complete.', battery_cost: 0 }
    }
    const current = objectives[this.mission.current]
    const { complete, reason } = checkObjective(current, this.rover, this.landmarks)
    if (!complete) return { text: `Objective not complete: ${reason}`, battery_cost: 0 }

    this.recordObjectiveComplete(current)
    this.mission = advanceMission(this.mission, objectives)
    if (this.mission.complete) return { text: 'All objectives complete! Mission SUCCESS.', battery_cost: 0 }
    return { text: `Objective complete! Next objective: ${this.mission.goal}`, battery_cost: 0 }
  }

  private recordObjectiveComplete(objective: Objective): void {
    const stamp = this.solStamp()
    if (objective.kind === 'reach' || objective.kind === 'return_to_base') {
      this.recordArtifact({
        kind: 'waypoint',
        landmarkId: objective.landmarkId,
        objectiveKind: objective.kind,
        ...stamp,
      })
    }
  }
}
