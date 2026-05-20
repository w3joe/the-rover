import { MarsViewer } from './viewer.js'
import { initSetup, showMissionControl } from './setup.js'
import {
  updateStatusBar,
  handleMessage,
  addLog,
  setActionStatus,
  updatePovHud,
  setPovPanelOpen,
  setReviewCloseHandler,
  clearAgentLog,
  clearLogBox,
  resetMissionPanel,
  setMissionStarting,
} from './ui.js'
import { buildReviewFromSnapshot, hideMissionReview, showMissionReview } from './review.js'
import type { MissionDef, WSClientMessage, WSMessage, WorldSnapshot } from '@mars/shared'

const WS_URL = 'ws://localhost:3001'
const RECONNECT_DELAY = 3000

let viewer: MarsViewer | null = null
let ws: WebSocket | null = null
let missionStarted = false
let isPaused = false
let povOpen = false
let lastSnapshot: WorldSnapshot | null = null
let setupInitialized = false
let pendingReview: { steps: number; elapsed_ms: number } | null = null

function send(msg: WSClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg))
  }
}

function initViewer(): MarsViewer {
  const container = document.getElementById('canvas-wrap')!
  if (viewer) viewer.dispose()
  viewer = new MarsViewer(container)
  if (povOpen) {
    const povWrap = document.getElementById('pov-canvas-wrap')
    viewer.setPovActive(true, povWrap ?? undefined)
  }
  if (lastSnapshot) viewer.update(lastSnapshot)
  return viewer
}

function getPauseBtn() { return document.getElementById('pause-btn') as HTMLButtonElement }
function getCancelBtn() { return document.getElementById('cancel-btn') as HTMLButtonElement }

function setMissionRunning(): void {
  const pause = getPauseBtn()
  pause.style.display = 'flex'
  pause.classList.remove('paused')
  pause.textContent = '⏸  Pause'
  getCancelBtn().style.display = 'flex'
}

function setMissionDone(): void {
  const pause = getPauseBtn()
  pause.style.display = 'none'
  getCancelBtn().style.display = 'none'
  setActionStatus('')
}

function wipeMissionClient(): void {
  missionStarted = false
  isPaused = false
  pendingReview = null
  hideMissionReview()
  clearAgentLog()
  clearLogBox()
  resetMissionPanel()
  setMissionDone()
  setPovOpen(false)
  showMissionControl()
}

function setupSpeedButtons(): void {
  document.querySelectorAll<HTMLButtonElement>('.speed-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const multiplier = Number(btn.dataset.speed) as 1 | 4 | 8
      send({ type: 'set_speed', multiplier })
      document.querySelectorAll('.speed-btn').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
    })
  })
}

function setSpeedActive(speed: 1 | 4 | 8): void {
  document.querySelectorAll<HTMLButtonElement>('.speed-btn').forEach(btn => {
    btn.classList.toggle('active', Number(btn.dataset.speed) === speed)
  })
}

function setPovOpen(open: boolean): void {
  povOpen = open
  setPovPanelOpen(open)
  if (viewer) {
    const povWrap = document.getElementById('pov-canvas-wrap')
    viewer.setPovActive(open, povWrap ?? undefined)
  }
}

function setupPovButton(): void {
  const povBtn = document.getElementById('pov-btn') as HTMLButtonElement
  const povClose = document.getElementById('pov-close') as HTMLButtonElement

  const toggle = () => setPovOpen(!povOpen)
  povBtn.onclick = toggle
  povClose.onclick = () => setPovOpen(false)
}

function onLaunchMission(mission: MissionDef): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert('Not connected to the agent server. Start the server with pnpm dev.')
    return
  }
  hideMissionReview()
  missionStarted = true
  setMissionStarting(mission.name)
  setMissionRunning()
  send({ type: 'start_mission', mission })
  addLog(`Launching: ${mission.name}`)
}

function onReviewClose(): void {
  missionStarted = false
  showMissionControl()
}

function setupButtons(): void {
  const pauseBtn = getPauseBtn()
  pauseBtn.onclick = () => {
    if (!isPaused) {
      isPaused = true
      send({ type: 'pause_mission' })
      pauseBtn.classList.add('paused')
      pauseBtn.textContent = '▶  Resume'
    } else {
      isPaused = false
      send({ type: 'resume_mission' })
      pauseBtn.classList.remove('paused')
      pauseBtn.textContent = '⏸  Pause'
    }
  }

  const cancelBtn = getCancelBtn()
  cancelBtn.onclick = () => {
    if (!missionStarted) return
    send({ type: 'cancel_mission' })
    wipeMissionClient()
    addLog('Mission cancelled.')
  }

  setupSpeedButtons()
  setupPovButton()
}

function connect(): void {
  const v = initViewer()
  getPauseBtn().style.display = 'none'
  getCancelBtn().style.display = 'none'

  ws = new WebSocket(WS_URL)

  ws.onopen = () => {
    addLog('Connected.')
    setupButtons()
    setSpeedActive(8)
    send({ type: 'set_speed', multiplier: 8 })
    setReviewCloseHandler(onReviewClose)
    if (missionStarted && !isPaused) setMissionRunning()
  }

  ws.onmessage = (event: MessageEvent<string>) => {
    let msg: WSMessage
    try { msg = JSON.parse(event.data) as WSMessage } catch { return }

    if (msg.type === 'mission_complete') {
      setMissionDone()
      if (msg.success) {
        pendingReview = { steps: msg.steps, elapsed_ms: msg.elapsed_ms }
      } else {
        pendingReview = null
      }
    }

    if (msg.type === 'request_pov_capture' && viewer) {
      const imageBase64 = viewer.capturePovScreenshot(msg.snapshot) ?? ''
      send({ type: 'pov_capture', captureId: msg.captureId, imageBase64 })
    }

    if (msg.type === 'mission_cancelled') {
      wipeMissionClient()
    }

    const { snapshot, catalogPayload, review } = handleMessage(msg)

    if (review) {
      pendingReview = null
    } else if (pendingReview && msg.type === 'mission_complete' && msg.success) {
      const meta = pendingReview
      requestAnimationFrame(() => {
        if (!pendingReview || pendingReview !== meta || !lastSnapshot) return
        showMissionReview(
          buildReviewFromSnapshot(lastSnapshot, meta.steps, meta.elapsed_ms),
          onReviewClose,
        )
        pendingReview = null
      })
    }

    if (catalogPayload && !setupInitialized) {
      setupInitialized = true
      initSetup(catalogPayload.presets, catalogPayload.catalog, onLaunchMission)
    }

    if (snapshot) {
      lastSnapshot = snapshot
      v.update(snapshot)
      updateStatusBar(snapshot)
      if (povOpen) {
        updatePovHud(snapshot, { missionRunning: missionStarted, paused: snapshot.paused })
      }

      if (snapshot.paused !== isPaused) {
        isPaused = snapshot.paused
        const pauseBtn = getPauseBtn()
        if (isPaused) {
          pauseBtn.classList.add('paused')
          pauseBtn.textContent = '▶  Resume'
        } else {
          pauseBtn.classList.remove('paused')
          pauseBtn.textContent = '⏸  Pause'
        }
      }

      setSpeedActive(snapshot.speed)
    }
  }

  ws.onclose = () => {
    addLog(`Disconnected. Retrying in ${RECONNECT_DELAY / 1000}s...`)
    setTimeout(() => connect(), RECONNECT_DELAY)
  }

  ws.onerror = () => addLog('WebSocket error.')
}

connect()
