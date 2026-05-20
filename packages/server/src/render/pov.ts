import puppeteer, { type Browser, type Page } from 'puppeteer'
import type { WorldSnapshot } from '@mars/shared'

let browser: Browser | null = null
let page: Page | null = null

const POV_HTML = /* html */ `<!DOCTYPE html>
<html>
<head>
<style>body{margin:0;overflow:hidden;background:#1a0a00;}</style>
</head>
<body>
<canvas id="c" width="400" height="300"></canvas>
<script type="importmap">
{"imports":{"three":"https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js"}}
</script>
<script type="module">
import * as THREE from 'three'

const canvas = document.getElementById('c')
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setSize(400, 300)
renderer.setClearColor(0x1a0800)

const scene = new THREE.Scene()
scene.fog = new THREE.Fog(0x1a0800, 20, 100)
scene.add(new THREE.AmbientLight(0xffaa77, 0.6))
const sun = new THREE.DirectionalLight(0xffcc88, 1.2)
sun.position.set(50, 80, 30)
scene.add(sun)

const camera = new THREE.PerspectiveCamera(60, 400 / 300, 0.1, 200)

let terrain = null
let landmarkMeshes = {}

function sampleLmHeight(x, z, heights, hmSize, worldSize) {
  const n = hmSize
  const cx = Math.max(0, Math.min(n - 1, (x / worldSize) * (n - 1)))
  const cz = Math.max(0, Math.min(n - 1, (z / worldSize) * (n - 1)))
  const ix = Math.min(Math.floor(cx), n - 2)
  const iz = Math.min(Math.floor(cz), n - 2)
  const fx = cx - ix
  const fz = cz - iz
  const h = (
    (heights[ix * n + iz] ?? 0) * (1 - fx) * (1 - fz) +
    (heights[(ix + 1) * n + iz] ?? 0) * fx * (1 - fz) +
    (heights[ix * n + iz + 1] ?? 0) * (1 - fx) * fz +
    (heights[(ix + 1) * n + iz + 1] ?? 0) * fx * fz
  )
  return h * 1.5
}

function buildTerrain(heights, hmSize, worldSize) {
  if (terrain) scene.remove(terrain)
  const geo = new THREE.PlaneGeometry(worldSize, worldSize, hmSize - 1, hmSize - 1)
  geo.rotateX(-Math.PI / 2)
  const n = hmSize
  const verts = geo.attributes.position
  for (let i = 0; i < verts.count; i++) {
    const iz = Math.floor(i / n)
    const ix = i % n
    verts.setY(i, (heights[ix * n + iz] ?? 0) * 1.5)
  }
  geo.computeVertexNormals()
  const mat = new THREE.MeshStandardMaterial({ color: 0xb05020, roughness: 1 })
  terrain = new THREE.Mesh(geo, mat)
  terrain.position.set(worldSize / 2, 0, worldSize / 2)
  scene.add(terrain)
}

const COLORS = { rock: 0x888888, beacon: 0x00ffff, base: 0x4488ff, spire: 0xffffff, relay: 0xffaa00, tool: 0x00ff88, crater: 0x442200 }

function updateLandmarks(landmarks, heights, hmSize, worldSize) {
  const seen = new Set()
  for (const lm of landmarks) {
    seen.add(lm.id)
    if (!landmarkMeshes[lm.id]) {
      const geo = lm.type === 'spire'
        ? new THREE.ConeGeometry(1.5, 8, 6)
        : lm.type === 'crater'
          ? new THREE.RingGeometry(lm.radius * 0.6, lm.radius, 16)
          : new THREE.BoxGeometry(lm.radius * 1.2, 2, lm.radius * 1.2)
      const mat = new THREE.MeshStandardMaterial({ color: COLORS[lm.type] ?? 0x888888 })
      const mesh = new THREE.Mesh(geo, mat)
      scene.add(mesh)
      landmarkMeshes[lm.id] = mesh
    }
    const mesh = landmarkMeshes[lm.id]
    const lmY = sampleLmHeight(lm.x, lm.z, heights, hmSize, worldSize)
    mesh.position.set(lm.x, lmY + 1, lm.z)
  }
  for (const id of Object.keys(landmarkMeshes)) {
    if (!seen.has(id)) { scene.remove(landmarkMeshes[id]); delete landmarkMeshes[id] }
  }
}

window.renderFrame = function(state) {
  buildTerrain(state.heightmap, state.heightmapSize, state.worldSize)
  updateLandmarks(state.landmarks, state.heightmap, state.heightmapSize, state.worldSize)

  const { pose } = state.rover
  const headingRad = (pose.heading_deg * Math.PI) / 180
  const pitchRad = (pose.mast_pitch_deg * Math.PI) / 180

  // Heading 0° = +Z; camera looks down -Z so yaw = π - heading aligns view forward.
  const camY = sampleLmHeight(pose.x, pose.z, state.heightmap, state.heightmapSize, state.worldSize) + 2.2
  camera.position.set(pose.x, camY, pose.z)
  camera.rotation.order = 'YXZ'
  camera.rotation.y = Math.PI - headingRad
  camera.rotation.x = pitchRad
  camera.rotation.z = 0

  renderer.render(scene, camera)
  return canvas.toDataURL('image/png').split(',')[1]
}
</script>
</body>
</html>`

async function ensureBrowser(): Promise<Page> {
  if (!browser) {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    })
  }
  if (!page) {
    page = await browser.newPage()
    await page.setContent(POV_HTML, { waitUntil: 'load' })
    await page.setViewport({ width: 400, height: 300 })
    await page.waitForFunction(() => typeof (window as unknown as Record<string, unknown>)['renderFrame'] === 'function', { timeout: 15000 })
  }
  return page
}

export async function renderPOV(snapshot: WorldSnapshot): Promise<string> {
  try {
    const p = await ensureBrowser()
    const base64 = await p.evaluate((state) => {
      return (window as unknown as { renderFrame: (s: unknown) => string }).renderFrame(state)
    }, snapshot as unknown as Record<string, unknown>)
    return base64
  } catch (err) {
    return ''
  }
}

export async function closePOVRenderer(): Promise<void> {
  if (browser) {
    await browser.close()
    browser = null
    page = null
  }
}
