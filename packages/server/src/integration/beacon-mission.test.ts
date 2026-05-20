/**
 * Integration test: a scripted "agent" drives the same World.dispatch path as the LLM loop
 * and completes the Beacon Reach preset (reach beacon_A, submit step).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { World } from '../world/World.js'
import { PRESET_MISSIONS } from '../world/mission.js'

const beaconMission = PRESET_MISSIONS.find(m => m.name === 'Beacon Reach')
assert.ok(beaconMission, 'Beacon Reach preset missing')

function headingToward(ax: number, az: number, bx: number, bz: number): number {
  return ((Math.atan2(bx - ax, bz - az) * 180) / Math.PI + 360) % 360
}

function distToBeacon(world: World, beacon: { x: number; z: number }): number {
  const { x, z } = world.rover.pose
  return Math.hypot(x - beacon.x, z - beacon.z)
}

/** Greedy navigator: turn toward beacon, move in chunks, arc in when the beacon collider blocks head-on approach. */
async function runScriptedBeaconAgent(world: World, maxIterations = 300): Promise<void> {
  const beacon = world.landmarkById('beacon_A')
  assert.ok(beacon)

  for (let i = 0; i < maxIterations && !world.isComplete(); i++) {
    if (world.mission.failed) break

    const range = distToBeacon(world, beacon)
    if (range <= 5) {
      await world.dispatch('submit_mission_step', {})
      continue
    }

    const { pose } = world.rover
    const targetHeading = headingToward(pose.x, pose.z, beacon.x, beacon.z)
    let delta = targetHeading - pose.heading_deg
    if (delta > 180) delta -= 360
    if (delta < -180) delta += 360

    // Head-on moves are blocked by the beacon collider; sidestep into the 5m objective ring.
    if (range < 8) {
      if (Math.abs(delta) > 15) {
        await world.dispatch('turn', { degrees: Math.sign(delta) * 20 })
      } else {
        await world.dispatch('turn', { degrees: 70 })
        await world.dispatch('move', { distance_m: 4 })
      }
      continue
    }

    if (Math.abs(delta) > 8) {
      const turn = Math.sign(delta) * Math.min(45, Math.abs(delta))
      await world.dispatch('turn', { degrees: turn })
      continue
    }

    const step = Math.min(25, Math.max(5, range - 8))
    const move = await world.dispatch('move', { distance_m: step })
    if (move.text.includes('Blocked') || move.text.includes('too steep') || move.text.includes('Boundary')) {
      await world.dispatch('turn', { degrees: 45 })
    }
  }
}

test('scripted agent completes Beacon Reach mission', async () => {
  const world = new World(beaconMission!)
  world.setSpeed(8)

  await runScriptedBeaconAgent(world)

  assert.equal(world.mission.failed, false, world.mission.failReason ?? 'failed')
  assert.equal(world.mission.complete, true, `stuck at objective ${world.mission.current}`)
})
