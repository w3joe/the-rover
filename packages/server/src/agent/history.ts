import type { MessageParam } from '@anthropic-ai/sdk/resources/messages.js'

/** Hard cap on messages before compressing — lenient to reduce mid-mission amnesia. */
const MAX_MESSAGES = 52
/** Recent turns kept verbatim (observations + tool rounds + replies). */
const KEEP_RECENT = 14
const MAX_SUMMARY_TOTAL_CHARS = 14_000
const MAX_OBS_DIGEST_CHARS = 4000
const MAX_TOOL_RESULT_CHARS = 650
const MAX_ASSISTANT_TEXT_CHARS = 500
const MAX_TOOL_INPUT_CHARS = 240

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

/** Pull text (+ image placeholders) from Anthropic tool_result content. */
function extractToolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block: Record<string, unknown>) => {
      if (block.type === 'text' && typeof block.text === 'string') return block.text
      if (block.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join(' ')
}

/**
 * Keep mission-critical fields from full JSON observations instead of a 120-char slice.
 */
function summarizeObservationPayload(raw: string): string {
  try {
    const o = JSON.parse(raw) as Record<string, unknown>
    const inv = o.inventory as Record<string, unknown> | undefined
    const mission = o.mission as Record<string, unknown> | undefined

    const digest = {
      sol: o.sol,
      time: o.time,
      battery_pct: o.battery_pct,
      weather: o.weather,
      visibility_m: o.visibility_m,
      beacon_ping_m: o.beacon_ping_m,
      pose: o.pose,
      mission: mission
        ? {
            objective_index: mission.objective_index,
            goal: mission.goal,
            hint: mission.hint,
            remaining_goals: mission.remaining_goals,
          }
        : undefined,
      inventory: inv
        ? {
            samples: inv.samples,
            sample_minerals: inv.sample_minerals,
            photos: inv.photos,
            has_repair_tool: inv.has_repair_tool,
          }
        : undefined,
      visible_count: Array.isArray(o.visible) ? o.visible.length : undefined,
      last_action_result:
        typeof o.last_action_result === 'string'
          ? truncate(o.last_action_result, 450)
          : o.last_action_result,
    }

    const line = `[obs] ${JSON.stringify(digest)}`
    return truncate(line, MAX_OBS_DIGEST_CHARS)
  } catch {
    return truncate(raw, MAX_OBS_DIGEST_CHARS)
  }
}

export function compactHistory(messages: MessageParam[]): void {
  if (messages.length <= MAX_MESSAGES) return

  const toCompress = messages.splice(0, messages.length - KEEP_RECENT)

  let summary = toCompress
    .map(m => {
      if (m.role === 'user') {
        if (typeof m.content === 'string') {
          const t = m.content.trim()
          if (t.startsWith('{')) {
            try {
              JSON.parse(t)
              return summarizeObservationPayload(t)
            } catch {
              /* not rover observation JSON */
            }
          }
          if (t.startsWith('[HISTORY SUMMARY')) return truncate(t, 3500)
          return truncate(`[msg] ${m.content}`, 600)
        }
        const blocks = (m.content as unknown) as Array<Record<string, unknown>>
        const toolResults = blocks.filter(b => b.type === 'tool_result')
        if (toolResults.length > 0) {
          return toolResults
            .map(r =>
              truncate(
                `[result] ${extractToolResultText(r.content)}`,
                MAX_TOOL_RESULT_CHARS,
              ))
            .join('\n')
        }
        return truncate(`[user blocks] ${JSON.stringify(m.content)}`, 800)
      }
      if (m.role === 'assistant') {
        const blocks = (Array.isArray(m.content) ? m.content : []) as unknown as Array<
          Record<string, unknown>
        >
        const texts = blocks
          .filter(b => b.type === 'text')
          .map(b => truncate(String(b.text ?? ''), MAX_ASSISTANT_TEXT_CHARS))
        const tools = blocks.filter(b => b.type === 'tool_use').map(b => {
          const name = String(b.name ?? '?')
          const input = (b.input as Record<string, unknown> | undefined) ?? {}
          const inp = truncate(
            Object.entries(input)
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(' '),
            MAX_TOOL_INPUT_CHARS,
          )
          return `${name}(${inp})`
        })
        return [...texts, ...tools].filter(Boolean).join(' | ')
      }
      return ''
    })
    .filter(Boolean)
    .join('\n')

  if (summary.length > MAX_SUMMARY_TOTAL_CHARS) {
    summary = `${summary.slice(0, MAX_SUMMARY_TOTAL_CHARS)}\n… [older summary lines truncated]`
  }

  messages.unshift({
    role: 'user',
    content: `[HISTORY SUMMARY — ${toCompress.length} messages compressed]\n${summary}`,
  })
}
