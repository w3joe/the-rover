export type RoverModelTier = 'haiku' | 'sonnet' | 'opus'

const MODEL_IDS: Record<RoverModelTier, string> = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
}

const DEFAULT_TIER: RoverModelTier = 'sonnet'

export function resolveAgentModel(): { tier: RoverModelTier; modelId: string } {
  const raw = (process.env.ROVER_MODEL ?? DEFAULT_TIER).toLowerCase().trim()
  if (raw in MODEL_IDS) {
    const tier = raw as RoverModelTier
    return { tier, modelId: MODEL_IDS[tier] }
  }
  console.warn(
    `[rover] Unknown ROVER_MODEL="${process.env.ROVER_MODEL}" — use haiku, sonnet, or opus. Defaulting to ${DEFAULT_TIER}.`,
  )
  return { tier: DEFAULT_TIER, modelId: MODEL_IDS[DEFAULT_TIER] }
}
