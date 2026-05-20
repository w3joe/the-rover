import Anthropic from '@anthropic-ai/sdk'
import type {
  ContentBlockParam,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from '@anthropic-ai/sdk/resources/messages.js'
import type { MissionDef, ToolCallLog, WSMessage } from '@mars/shared'
import { World } from '../world/World.js'
import { buildSystemPrompt, TOOL_SCHEMAS } from './prompts.js'
import { compactHistory } from './history.js'
import { resolveAgentModel } from './model.js'

type BroadcastFn = (msg: WSMessage) => void

const MAX_STEPS = 300

export async function runMission(
  world: World,
  missionDef: MissionDef,
  broadcast: BroadcastFn,
  signal?: AbortSignal,
): Promise<void> {
  const client = new Anthropic()
  const { tier, modelId } = resolveAgentModel()
  const messages: MessageParam[] = []
  let stepCount = 0
  const startTime = Date.now()
  const systemPrompt = buildSystemPrompt(missionDef)

  broadcast({ type: 'log', text: `Agent loop starting (${tier} / ${modelId})...` })

  while (!world.isComplete() && stepCount < MAX_STEPS && !signal?.aborted && !world.isCancelled()) {
    const obs = world.getObservation()
    messages.push({ role: 'user', content: JSON.stringify(obs, null, 2) })

    let response = await client.messages.create({
      model: modelId,
      max_tokens: 4096,
      system: systemPrompt,
      tools: TOOL_SCHEMAS,
      messages,
    })

    while (
      response.stop_reason === 'tool_use'
      && !signal?.aborted
      && !world.isCancelled()
    ) {
      const reasoning = (response.content as unknown as Array<Record<string, unknown>>)
        .filter(b => b.type === 'text')
        .map(b => String(b.text ?? ''))
        .join('')

      const toolUses = response.content.filter((b): b is ToolUseBlock => b.type === 'tool_use')
      messages.push({ role: 'assistant', content: response.content as ContentBlockParam[] })

      const toolResults: ToolResultBlockParam[] = []
      const toolLogs: ToolCallLog[] = []

      for (const tu of toolUses) {
        if (signal?.aborted || world.isCancelled()) break

        const isNote = tu.name === 'note'
        const inputSummary = isNote
          ? ''
          : Object.entries(tu.input as Record<string, unknown>)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
        broadcast({ type: 'action_start', action: tu.name, detail: inputSummary })

        const result = await world.dispatch(tu.name, tu.input as Record<string, unknown>)

        const content: ToolResultBlockParam['content'] = result.imageBase64
          ? [
              { type: 'image', source: { type: 'base64', media_type: 'image/png', data: result.imageBase64 } },
              { type: 'text', text: result.text },
            ]
          : result.text

        toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content })
        toolLogs.push({
          name: tu.name,
          input: isNote ? {} : (tu.input as Record<string, unknown>),
          result: isNote ? 'Note recorded.' : result.text,
          battery_cost: result.battery_cost,
        })
      }

      messages.push({ role: 'user', content: toolResults })

      const snapshot = world.getSnapshot()
      snapshot.stepCount = stepCount
      broadcast({ type: 'state', snapshot })
      broadcast({ type: 'agent_turn', reasoning, toolCalls: toolLogs, step: stepCount })

      if (world.isComplete()) break

      response = await client.messages.create({
        model: modelId,
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOL_SCHEMAS,
        messages,
      })
    }

    if (response.stop_reason === 'end_turn') {
      messages.push({ role: 'assistant', content: response.content as ContentBlockParam[] })
    }

    compactHistory(messages)
    stepCount++
    if (world.isComplete()) break
  }

  if (signal?.aborted || world.isCancelled()) {
    broadcast({ type: 'log', text: 'Mission cancelled.' })
    return
  }

  const elapsed = Date.now() - startTime
  const success = world.mission.complete && !world.mission.failed

  broadcast({ type: 'mission_complete', success, steps: stepCount, elapsed_ms: elapsed })
  if (success) {
    broadcast({ type: 'mission_review', review: world.getMissionReview(stepCount, elapsed) })
  }
  broadcast({
    type: 'log',
    text: success
      ? `Mission COMPLETE — ${stepCount} steps, ${(elapsed / 1000).toFixed(0)}s`
      : `Mission FAILED — ${world.mission.failReason ?? 'unknown'}`,
  })
}
