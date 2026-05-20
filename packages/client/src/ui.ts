import type { LandmarkCatalogEntry, MissionDef, MissionReview, ToolCallLog, WorldSnapshot, WSMessage } from '@mars/shared'
import { showMissionReview } from './review.js'

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T
}

function renderObjectiveList(mission: WorldSnapshot['mission']): void {
  const list = el('objective-list')
  list.innerHTML = ''

  mission.objectiveLabels.forEach((label, idx) => {
    const row = document.createElement('div')
    row.className = 'objective-row'
    if (mission.completed.includes(idx)) row.classList.add('done')
    else if (mission.current === idx && !mission.complete && !mission.failed) row.classList.add('active')

    const num = document.createElement('span')
    num.className = 'obj-num'
    num.textContent = `${idx + 1}.`

    const text = document.createElement('span')
    text.className = 'obj-text'
    text.textContent = label

    row.append(num, text)
    list.appendChild(row)
  })
}

export function updateStatusBar(snapshot: WorldSnapshot): void {
  const { rover, mission, beaconRangeM, stepCount } = snapshot
  el('s-sol').textContent = `${rover.sol}`
  el('s-time').textContent = `${String(Math.floor(rover.sol_minute / 60)).padStart(2, '0')}:${String(rover.sol_minute % 60).padStart(2, '0')}`

  const bat = el('s-bat')
  bat.textContent = `${rover.battery_pct.toFixed(1)}%`
  bat.className = `value battery ${rover.battery_pct < 20 ? 'low' : rover.battery_pct < 50 ? 'mid' : 'high'}`

  const weather = el('s-weather')
  weather.textContent = rover.weather
  weather.className = `value ${rover.weather === 'storm' ? 'weather-storm' : rover.weather === 'dusty' ? 'weather-dusty' : ''}`

  el('s-pos').textContent = `${rover.pose.x.toFixed(0)},${rover.pose.z.toFixed(0)}`
  el('s-hdg').textContent = `${rover.pose.heading_deg.toFixed(0)}°`
  el('s-beacon').textContent = `${beaconRangeM}m`
  el('s-step').textContent = `${stepCount}`

  renderObjectiveList(mission)

  const goalEl = el('mission-goal')
  const labelEl = el('mission-label')
  if (mission.complete) {
    labelEl.textContent = 'MISSION COMPLETE'
    goalEl.textContent = `All objectives completed. Sol ${rover.sol}.`
    goalEl.style.color = '#55ff99'
  } else if (mission.failed) {
    labelEl.textContent = 'MISSION FAILED'
    goalEl.textContent = mission.failReason ?? 'Unknown reason.'
    goalEl.style.color = '#ff4444'
  } else {
    labelEl.textContent = snapshot.paused ? 'Paused — objective' : 'Current objective'
    goalEl.textContent = mission.goal
    goalEl.style.color = ''
  }
}

export function setActionStatus(text: string): void {
  const el = document.getElementById('action-status')!
  if (text) {
    el.textContent = text
    el.style.display = 'block'
  } else {
    el.style.display = 'none'
  }
}

export function addAgentTurn(reasoning: string, toolCalls: ToolCallLog[], step: number): void {
  const box = el('agent-box')
  box.querySelector('.connecting')?.remove()

  const block = document.createElement('div')
  block.className = 'turn-block'

  const stepEl = document.createElement('div')
  stepEl.className = 'turn-step'
  stepEl.textContent = `STEP ${step}`
  block.appendChild(stepEl)

  if (reasoning.trim()) {
    const r = document.createElement('div')
    r.className = 'reasoning'
    r.textContent = reasoning.slice(0, 400) + (reasoning.length > 400 ? '…' : '')
    block.appendChild(r)
  }

  for (const tc of toolCalls) {
    const div = document.createElement('div')
    div.className = 'tool-call'
    const isNote = tc.name === 'note'
    const args = isNote
      ? ''
      : Object.entries(tc.input).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ')
    const callLabel = isNote ? 'note()' : `${tc.name}(${args})`
    const resultText = isNote ? 'Note recorded.' : tc.result.slice(0, 200)
    div.innerHTML = `
      <span class="tool-name">${callLabel}</span>
      ${tc.battery_cost > 0 ? `<span class="tool-cost">-${tc.battery_cost.toFixed(1)}%</span>` : ''}
      <div class="tool-result">${resultText}</div>
    `
    block.appendChild(div)
  }

  box.appendChild(block)
  box.scrollTop = box.scrollHeight

  const blocks = box.querySelectorAll('.turn-block')
  if (blocks.length > 30) blocks[0].remove()
}

export function updatePovHud(
  snapshot: WorldSnapshot,
  opts: { missionRunning: boolean; paused: boolean },
): void {
  const { rover } = snapshot
  const panel = document.getElementById('pov-panel')
  if (!panel) return

  panel.classList.remove('weather-dusty', 'weather-storm')
  if (rover.weather === 'dusty') panel.classList.add('weather-dusty')
  else if (rover.weather === 'storm') panel.classList.add('weather-storm')

  el('pov-hdg').textContent = `${rover.pose.heading_deg.toFixed(0)}°`
  el('pov-pitch').textContent = `${rover.pose.mast_pitch_deg.toFixed(0)}°`
  el('pov-pos').textContent = `${rover.pose.x.toFixed(0)},${rover.pose.z.toFixed(0)}`
  el('pov-vis').textContent = `${rover.visibility_m}m`
  el('pov-tstamp').textContent =
    `SOL ${rover.sol} ${String(Math.floor(rover.sol_minute / 60)).padStart(2, '0')}:${String(rover.sol_minute % 60).padStart(2, '0')}`

  const rec = el('pov-rec')
  const showRec = opts.missionRunning && !opts.paused && !snapshot.mission.complete && !snapshot.mission.failed
  rec.classList.toggle('live', showRec)
}

export function setPovPanelOpen(open: boolean): void {
  const panel = el('pov-panel')
  const btn = el('pov-btn')
  panel.classList.toggle('open', open)
  btn.classList.toggle('active', open)
}

export function addLog(text: string): void {
  const log = el('log-box')
  const line = document.createElement('div')
  line.textContent = `${new Date().toLocaleTimeString()} ${text}`
  log.appendChild(line)
  log.scrollTop = log.scrollHeight
}

export function clearAgentLog(): void {
  const box = el('agent-box')
  box.innerHTML = ''
}

export function clearLogBox(): void {
  el('log-box').innerHTML = ''
}

export function resetMissionPanel(): void {
  const list = el('objective-list')
  list.innerHTML = ''
  el('mission-label').textContent = 'Mission'
  el('mission-goal').textContent = 'No active mission.'
  el('mission-goal').style.color = ''
}

export function setMissionStarting(name: string): void {
  el('mission-label').textContent = 'Starting mission'
  el('mission-goal').textContent = name
  el('mission-goal').style.color = '#ffcc66'
  el('objective-list').innerHTML = ''
}

export type CatalogPayload = { presets: MissionDef[]; catalog: LandmarkCatalogEntry[] }

let onReviewClose: (() => void) | null = null

export function setReviewCloseHandler(handler: () => void): void {
  onReviewClose = handler
}

export function handleMessage(msg: WSMessage): {
  snapshot?: WorldSnapshot
  catalogPayload?: CatalogPayload
  review?: MissionReview
} {
  switch (msg.type) {
    case 'agent_turn':
      addAgentTurn(msg.reasoning, msg.toolCalls, msg.step)
      break
    case 'log':
      addLog(msg.text)
      break
    case 'action_start':
      setActionStatus(
        msg.action === 'note'
          ? 'note'
          : msg.detail
            ? `${msg.action}  ${msg.detail}`
            : msg.action,
      )
      break
    case 'mission_complete':
      setActionStatus('')
      addLog(msg.success
        ? `✓ Mission complete in ${msg.steps} steps`
        : `✗ Mission failed after ${msg.steps} steps`)
      break
    case 'mission_review':
      addLog(`Review ready — ${msg.review.artifacts.length} artifact(s).`)
      showMissionReview(msg.review, () => onReviewClose?.())
      return { review: msg.review }
    case 'mission_cancelled':
      break
    case 'mission_catalog':
      return { catalogPayload: { presets: msg.presets, catalog: msg.catalog } }
    case 'state':
      return { snapshot: msg.snapshot }
  }
  return {}
}
