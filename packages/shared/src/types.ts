export interface Vec2 {
  x: number
  z: number
}

export interface Pose {
  x: number
  y: number
  z: number
  heading_deg: number
  mast_pitch_deg: number
}

export type Weather = 'clear' | 'dusty' | 'storm'
export type LandmarkType = 'rock' | 'beacon' | 'base' | 'spire' | 'relay' | 'tool' | 'crater'
export type Mineral = 'basalt' | 'sedimentary' | 'volcanic' | 'unknown'
export type RepairStage = 'intact' | 'assessed' | 'coupling_fixed' | 'repaired'

export interface Landmark {
  id: string
  type: LandmarkType
  x: number
  z: number
  radius: number
  tags: string[]
  mineral?: Mineral
  repairStage?: RepairStage
  repairIssues?: string[]
  photographed?: boolean
}

export interface RoverState {
  pose: Pose
  battery_pct: number
  sol: number
  sol_minute: number
  weather: Weather
  visibility_m: number
  inventory: {
    samples: string[]
    /** Same order as samples — survives rock removal from the world map. */
    sampleMinerals: Mineral[]
    photos: string[]
    hasRepairTool: boolean
  }
}

// ── Missions ──────────────────────────────────────────────────────────────

export type ObjectiveKind = 'reach' | 'collect_samples' | 'photograph' | 'repair' | 'return_to_base'

export type Objective =
  | { kind: 'reach'; landmarkId: string; radiusM: number }
  | { kind: 'collect_samples'; count: number; distinctMinerals: boolean }
  | { kind: 'photograph'; landmarkId: string }
  | { kind: 'repair'; landmarkId: string }
  | { kind: 'return_to_base'; landmarkId: string; radiusM: number; deadlineSolMinute?: number }

export type StormFrequency = 'none' | 'low' | 'normal' | 'high'

export interface WorldConditions {
  seed: number
  startBatteryPct: number   // 10–100
  startSolMinute: number    // 0–520
  stormFrequency: StormFrequency
}

export interface MissionDef {
  name: string
  objectives: Objective[]
  conditions: WorldConditions
}

export interface LandmarkCatalogEntry {
  id: string
  type: LandmarkType
  tags: string[]
}

export interface MissionStatus {
  name: string
  objectiveLabels: string[]   // short label per objective — drives the checklist
  goal: string                // full description of the current objective
  current: number             // 0-based index of current objective
  completed: number[]
  complete: boolean
  failed: boolean
  failReason?: string
}

/** Data artifact collected during a mission (shown in post-success review). */
export type CollectedArtifact =
  | {
      kind: 'photograph'
      landmarkId: string
      landmarkType: LandmarkType
      imageBase64?: string
      sol: number
      solMinute: number
    }
  | {
      kind: 'sample'
      rockId: string
      mineral: Mineral
      tags: string[]
      sol: number
      solMinute: number
    }
  | {
      kind: 'repair'
      landmarkId: string
      action: 'assessed' | 'coupling_fixed' | 'repaired'
      issues?: string[]
      sol: number
      solMinute: number
    }
  | {
      kind: 'waypoint'
      landmarkId: string
      objectiveKind: 'reach' | 'return_to_base'
      sol: number
      solMinute: number
    }

export interface MissionReview {
  missionName: string
  steps: number
  elapsed_ms: number
  artifacts: CollectedArtifact[]
}

// ── World snapshot & telemetry ─────────────────────────────────────────────

export interface WorldSnapshot {
  rover: RoverState
  landmarks: Landmark[]
  mission: MissionStatus
  heightmap: number[]
  heightmapSize: number
  worldSize: number
  stepCount: number
  beaconRangeM: number
  paused: boolean
  speed: 1 | 4 | 8
}

export interface ToolCallLog {
  name: string
  input: Record<string, unknown>
  result: string
  battery_cost: number
}

// Server → Client
export type WSMessage =
  | { type: 'state'; snapshot: WorldSnapshot }
  | { type: 'agent_turn'; reasoning: string; toolCalls: ToolCallLog[]; step: number }
  | { type: 'mission_complete'; success: boolean; steps: number; elapsed_ms: number; review?: MissionReview }
  | { type: 'mission_review'; review: MissionReview }
  | { type: 'mission_cancelled' }
  | { type: 'log'; text: string }
  | { type: 'action_start'; action: string; detail: string }
  | { type: 'server_ready' }
  | { type: 'mission_catalog'; presets: MissionDef[]; catalog: LandmarkCatalogEntry[] }
  | { type: 'request_pov_capture'; captureId: string; snapshot: WorldSnapshot }

// Client → Server
export type WSClientMessage =
  | { type: 'start_mission'; mission: MissionDef }
  | { type: 'cancel_mission' }
  | { type: 'pause_mission' }
  | { type: 'resume_mission' }
  | { type: 'set_speed'; multiplier: 1 | 4 | 8 }
  | { type: 'pov_capture'; captureId: string; imageBase64: string }

export interface AgentObservation {
  sol: number
  time: string
  battery_pct: number
  weather: Weather
  visibility_m: number
  pose: Omit<Pose, 'y'>
  beacon_ping_m: number
  inventory: {
    samples: string[]
    sample_minerals: Mineral[]
    photos: string[]
    has_repair_tool: boolean
  }
  visible: VisibleObject[]
  known_landmarks: KnownLandmark[]
  last_action_result: string
  mission: {
    objective_index: number
    total: number
    goal: string
    hint: string
    remaining_goals: string[]
  }
}

export interface VisibleObject {
  id: string
  type: LandmarkType
  bearing_deg: number
  range_m: number
  tags: string[]
  mineral?: Mineral
}

export interface KnownLandmark {
  id: string
  type: LandmarkType
  bearing_deg: number
  range_m: number
}
