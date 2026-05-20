import { World } from './world/World.js'
import { runMission } from './agent/loop.js'
import { createWSServer } from './ws/server.js'
import { PRESET_MISSIONS } from './world/mission.js'
import { landmarkCatalog } from './world/landmarks.js'
import { DEFAULT_SPEED_MULTIPLIER } from '@mars/shared'
import type { MissionDef, WorldSnapshot, WSClientMessage } from '@mars/shared'

const WS_PORT = 3001
const POV_CAPTURE_TIMEOUT_MS = 3000

async function main() {
  const { broadcast, onClientMessage, onClientConnect } = createWSServer(WS_PORT)

  const presets = PRESET_MISSIONS
  const catalog = landmarkCatalog()

  const pendingPovCaptures = new Map<string, (imageBase64: string | undefined) => void>()
  let povCaptureSeq = 0

  function requestClientPovCapture(snapshot: WorldSnapshot): Promise<string | undefined> {
    return new Promise((resolve) => {
      const captureId = String(++povCaptureSeq)
      const timer = setTimeout(() => {
        pendingPovCaptures.delete(captureId)
        resolve(undefined)
      }, POV_CAPTURE_TIMEOUT_MS)

      pendingPovCaptures.set(captureId, (imageBase64) => {
        clearTimeout(timer)
        pendingPovCaptures.delete(captureId)
        resolve(imageBase64?.length ? imageBase64 : undefined)
      })

      broadcast({ type: 'request_pov_capture', captureId, snapshot })
    })
  }

  function clearPendingPovCaptures(): void {
    for (const resolve of pendingPovCaptures.values()) resolve(undefined)
    pendingPovCaptures.clear()
  }

  function resetWorld(): World {
    const w = new World(presets[0], requestClientPovCapture)
    w.setSpeed(DEFAULT_SPEED_MULTIPLIER)
    w.setStepCallback(() => {
      broadcast({ type: 'state', snapshot: w.getSnapshot() })
    })
    return w
  }

  let world = resetWorld()
  let missionRunning = false
  let missionAbort: AbortController | null = null
  /** Invalidates in-flight runOneMission finally blocks after cancel or superseding start. */
  let activeRunId = 0
  let missionQueue: Promise<void> = Promise.resolve()

  function abortActiveMission(): void {
    missionAbort?.abort()
    clearPendingPovCaptures()
    world.cancel()
  }

  function finishCancel(): void {
    world = resetWorld()
    missionRunning = false
    missionAbort = null
    broadcast({ type: 'mission_cancelled' })
    broadcast({ type: 'state', snapshot: world.getSnapshot() })
    broadcast({ type: 'log', text: 'Mission cancelled — world reset.' })
  }

  function cancelMissionNow(): void {
    activeRunId++
    abortActiveMission()
    finishCancel()
  }

  /** Stop an in-flight mission when a new one is launched — no mission_cancelled (avoids wiping the new launch UI). */
  function abortForSupersede(): void {
    activeRunId++
    abortActiveMission()
    world = resetWorld()
    missionRunning = false
    missionAbort = null
  }

  async function runOneMission(missionDef: MissionDef): Promise<void> {
    const runId = ++activeRunId
    missionRunning = true
    const ac = new AbortController()
    missionAbort = ac

    world = new World(missionDef, requestClientPovCapture)
    world.setSpeed(DEFAULT_SPEED_MULTIPLIER)
    world.setStepCallback(() => {
      broadcast({ type: 'state', snapshot: world.getSnapshot() })
    })

    broadcast({ type: 'state', snapshot: world.getSnapshot() })
    broadcast({ type: 'log', text: `Mission starting: ${missionDef.name}` })

    try {
      await runMission(world, missionDef, broadcast, ac.signal)
    } catch (err) {
      console.error(err)
      broadcast({
        type: 'log',
        text: `Mission error: ${err instanceof Error ? err.message : 'unknown'}`,
      })
    } finally {
      if (runId !== activeRunId) return
      if (missionAbort !== ac) return

      if (ac.signal.aborted || world.isCancelled()) {
        if (missionRunning) finishCancel()
      } else {
        missionRunning = false
        missionAbort = null
      }
    }
  }

  onClientConnect((send) => {
    send({ type: 'mission_catalog', presets, catalog })
    send({ type: 'state', snapshot: world.getSnapshot() })
  })

  onClientMessage(async (msg: WSClientMessage) => {
    if (msg.type === 'pov_capture') {
      pendingPovCaptures.get(msg.captureId)?.(msg.imageBase64)
      return
    }

    if (msg.type === 'cancel_mission') {
      cancelMissionNow()
      return
    }

    if (msg.type === 'start_mission') {
      const missionDef = msg.mission as MissionDef
      if (missionRunning) {
        abortForSupersede()
      }
      missionQueue = missionQueue
        .then(() => runOneMission(missionDef))
        .catch(err => {
          console.error(err)
          missionRunning = false
          missionAbort = null
          broadcast({
            type: 'log',
            text: `Mission error: ${err instanceof Error ? err.message : 'unknown'}`,
          })
        })
      return
    }

    if (msg.type === 'pause_mission' && missionRunning && !world.isPaused()) {
      world.pause()
      broadcast({ type: 'log', text: 'Mission paused.' })
      broadcast({ type: 'state', snapshot: world.getSnapshot() })
    } else if (msg.type === 'resume_mission' && missionRunning && world.isPaused()) {
      world.resume()
      broadcast({ type: 'log', text: 'Mission resumed.' })
    } else if (msg.type === 'set_speed') {
      world.setSpeed(msg.multiplier)
      broadcast({ type: 'state', snapshot: world.getSnapshot() })
    }
  })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
