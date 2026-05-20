import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import type { Landmark, WorldSnapshot } from '@mars/shared'
import { heightAtVertexIndex, sampleHeightVisual } from '@mars/shared/terrain'

const LANDMARK_COLORS: Record<string, number> = {
  rock: 0x888888,
  beacon: 0x00ffff,
  base: 0x4488ff,
  spire: 0xffffff,
  relay: 0xffaa00,
  tool: 0x00ff88,
  crater: 0x442200,
}

/** Mast camera offset in rover local space (matches buildRoverMesh cam box). */
const POV_LOCAL_OFFSET = new THREE.Vector3(0, 2.2, 0.5)
/** Rover mesh front faces local +Z (heading 0° = world +Z). */
const ROVER_FORWARD_LOCAL = new THREE.Vector3(0, 0, 1)
/** Wheel center Y in rover local space; group Y = terrain surface so wheel bottoms touch ground. */
const ROVER_GROUND_OFFSET = 0.4
const _povPos = new THREE.Vector3()
const _povForward = new THREE.Vector3()
const _povRight = new THREE.Vector3()
const _povTarget = new THREE.Vector3()
const POV_INTERNAL_W = 480
const POV_INTERNAL_H = 360

export class MarsViewer {
  private renderer: THREE.WebGLRenderer
  private scene: THREE.Scene
  private camera: THREE.PerspectiveCamera
  private terrainMesh: THREE.Mesh | null = null
  private roverMesh: THREE.Group
  private landmarkMeshes = new Map<string, THREE.Object3D>()
  private landmarkInfo = new Map<string, Landmark>()
  private meshToLandmarkId = new Map<number, string>()
  private pathPoints: THREE.Vector3[] = []
  private pathLine: THREE.Line | null = null
  private controls: OrbitControls
  private animFrame = 0
  private raycaster = new THREE.Raycaster()
  private mouse = new THREE.Vector2()
  private tooltipEl: HTMLElement

  private heightmap: number[] = []
  private heightmapSize = 64
  private worldSize = 200

  private povActive = false
  private povCamera: THREE.PerspectiveCamera
  private povRenderer: THREE.WebGLRenderer | null = null
  /** Offscreen POV renderer for photograph capture (works even when ◎ CAM panel is closed). */
  private povCaptureRenderer: THREE.WebGLRenderer | null = null
  private povContainer: HTMLElement | null = null
  private lastSnapshot: WorldSnapshot | null = null

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(window.devicePixelRatio)
    this.renderer.setClearColor(0x0d0500)
    this.renderer.shadowMap.enabled = true
    container.appendChild(this.renderer.domElement)

    this.tooltipEl = document.createElement('div')
    Object.assign(this.tooltipEl.style, {
      position: 'absolute',
      background: 'rgba(6,2,0,0.88)',
      color: '#e8c090',
      padding: '5px 10px',
      borderRadius: '4px',
      fontSize: '11px',
      fontFamily: 'monospace',
      lineHeight: '1.5',
      pointerEvents: 'none',
      display: 'none',
      zIndex: '20',
      border: '1px solid rgba(255,170,50,0.35)',
      whiteSpace: 'nowrap',
    })
    container.appendChild(this.tooltipEl)

    this.renderer.domElement.addEventListener('mousemove', (e) => this.onMouseMove(e))
    this.renderer.domElement.addEventListener('mouseleave', () => {
      this.tooltipEl.style.display = 'none'
    })

    this.scene = new THREE.Scene()
    this.scene.fog = new THREE.FogExp2(0x0d0500, 0.005)

    const ambient = new THREE.AmbientLight(0xffaa77, 0.5)
    this.scene.add(ambient)
    const sun = new THREE.DirectionalLight(0xffcc88, 1.5)
    sun.position.set(80, 120, 60)
    sun.castShadow = true
    this.scene.add(sun)

    this.camera = new THREE.PerspectiveCamera(55, 1, 0.5, 500)
    this.povCamera = new THREE.PerspectiveCamera(60, 4 / 3, 0.5, 500)
    this.povCamera.rotation.order = 'YXZ'
    // Start above and slightly behind the rover spawn point (12, 12)
    this.camera.position.set(12, 40, -20)

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.set(12, 0, 12)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 4
    this.controls.maxDistance = 180
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02  // don't clip below terrain
    this.controls.update()

    this.roverMesh = this.buildRoverMesh()
    this.scene.add(this.roverMesh)

    this.resize(container)
    window.addEventListener('resize', () => {
      this.resize(container)
      if (this.povActive) this.resizePov()
    })
    this.animate()
  }

  isPovActive(): boolean {
    return this.povActive
  }

  setPovActive(on: boolean, povContainer?: HTMLElement): void {
    if (on === this.povActive) return
    this.povActive = on

    if (on && povContainer) {
      this.povContainer = povContainer
      if (!this.povRenderer) {
        this.povRenderer = new THREE.WebGLRenderer({ antialias: true })
        this.povRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
        this.povRenderer.setClearColor(0x0d0500)
        povContainer.appendChild(this.povRenderer.domElement)
      }
      this.resizePov()
      if (this.lastSnapshot) this.updatePovCamera(this.lastSnapshot)
    } else {
      this.povContainer = null
      if (this.povRenderer) {
        this.povRenderer.domElement.remove()
        this.povRenderer.dispose()
        this.povRenderer = null
      }
    }
  }

  private resizePov(): void {
    if (!this.povRenderer || !this.povContainer) return
    const w = this.povContainer.clientWidth
    const h = this.povContainer.clientHeight
    if (w <= 0 || h <= 0) return
    this.povRenderer.setSize(POV_INTERNAL_W, POV_INTERNAL_H, false)
    this.povRenderer.domElement.style.width = '100%'
    this.povRenderer.domElement.style.height = '100%'
    this.povCamera.aspect = 4 / 3
    this.povCamera.updateProjectionMatrix()
  }

  private updatePovCamera(snapshot: WorldSnapshot): void {
    const pitchRad = (snapshot.rover.pose.mast_pitch_deg * Math.PI) / 180

    // Match rover mesh pose so POV turns with the vehicle (heading 0° = +Z).
    this.roverMesh.updateWorldMatrix(true, false)

    _povPos.copy(POV_LOCAL_OFFSET).applyMatrix4(this.roverMesh.matrixWorld)
    this.povCamera.position.copy(_povPos)

    _povForward.copy(ROVER_FORWARD_LOCAL).applyQuaternion(this.roverMesh.quaternion)
    _povRight.set(1, 0, 0).applyQuaternion(this.roverMesh.quaternion)
    _povForward.applyAxisAngle(_povRight, pitchRad)

    _povTarget.copy(_povPos).add(_povForward)
    this.povCamera.lookAt(_povTarget)
  }

  private onMouseMove(e: MouseEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.mouse.x = ((e.clientX - rect.left) / rect.width) * 2 - 1
    this.mouse.y = -((e.clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.mouse, this.camera)

    const targets = [...this.landmarkMeshes.values()]
    const intersects = this.raycaster.intersectObjects(targets, true)

    if (intersects.length > 0) {
      const lmId = this.meshToLandmarkId.get(intersects[0].object.id)
      const lm = lmId ? this.landmarkInfo.get(lmId) : undefined
      if (lm) {
        const lines: string[] = [`<b>${lm.id}</b>`, `type: ${lm.type}`]
        if (lm.tags.length) lines.push(`tags: ${lm.tags.join(', ')}`)
        if (lm.mineral && lm.mineral !== 'unknown') lines.push(`mineral: ${lm.mineral}`)
        if (lm.repairStage && lm.repairStage !== 'intact') lines.push(`repair: ${lm.repairStage}`)
        this.tooltipEl.innerHTML = lines.join('<br>')
        this.tooltipEl.style.display = 'block'
        this.tooltipEl.style.left = `${e.clientX - rect.left + 14}px`
        this.tooltipEl.style.top = `${e.clientY - rect.top - 10}px`
        return
      }
    }
    this.tooltipEl.style.display = 'none'
  }

  private buildRoverMesh(): THREE.Group {
    const g = new THREE.Group()
    const body = new THREE.Mesh(
      new THREE.BoxGeometry(2, 1, 3),
      new THREE.MeshStandardMaterial({ color: 0xcccccc }),
    )
    body.position.y = 0.5
    g.add(body)
    const wheel = (x: number, z: number) => {
      const m = new THREE.Mesh(
        new THREE.CylinderGeometry(0.4, 0.4, 0.3, 8),
        new THREE.MeshStandardMaterial({ color: 0x444444 }),
      )
      m.rotation.z = Math.PI / 2
      m.position.set(x, 0.4, z)
      return m
    }
    g.add(wheel(-1.2, -1), wheel(1.2, -1), wheel(-1.2, 1), wheel(1.2, 1))
    const mast = new THREE.Mesh(
      new THREE.CylinderGeometry(0.1, 0.1, 1.5),
      new THREE.MeshStandardMaterial({ color: 0x999999 }),
    )
    mast.position.set(0, 1.75, 0.5)
    g.add(mast)
    const cam = new THREE.Mesh(
      new THREE.BoxGeometry(0.4, 0.3, 0.5),
      new THREE.MeshStandardMaterial({ color: 0x3333ff }),
    )
    cam.position.set(0, 2.6, 0.5)
    g.add(cam)
    return g
  }

  private resize(container: HTMLElement): void {
    const w = container.clientWidth
    const h = container.clientHeight
    this.renderer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  private animate(): void {
    this.animFrame = requestAnimationFrame(() => this.animate())
    this.controls.update()
    if (this.povActive && this.lastSnapshot) {
      this.updatePovCamera(this.lastSnapshot)
    }
    this.renderer.render(this.scene, this.camera)
    if (this.povActive && this.povRenderer) {
      this.povRenderer.render(this.scene, this.povCamera)
    }
  }

  update(snapshot: WorldSnapshot): void {
    this.lastSnapshot = snapshot
    this.updateTerrain(snapshot)
    this.updateRover(snapshot)
    this.updateLandmarks(snapshot)
    this.updatePath(snapshot)
    this.updateOrbitTarget(snapshot)
    if (this.povActive) this.updatePovCamera(snapshot)
  }

  /** Mast-camera frame from the live viewer scene (same rig as ◎ CAM). */
  capturePovScreenshot(snapshot: WorldSnapshot): string | null {
    this.update(snapshot)
    this.updatePovCamera(snapshot)

    if (!this.povCaptureRenderer) {
      this.povCaptureRenderer = new THREE.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: true,
      })
      this.povCaptureRenderer.setSize(POV_INTERNAL_W, POV_INTERNAL_H, false)
      this.povCaptureRenderer.setClearColor(0x0d0500)
    }

    this.povCaptureRenderer.render(this.scene, this.povCamera)
    try {
      const dataUrl = this.povCaptureRenderer.domElement.toDataURL('image/png')
      const base64 = dataUrl.split(',')[1]
      return base64?.length ? base64 : null
    } catch {
      return null
    }
  }

  private sampleTerrain(x: number, z: number): number {
    if (!this.heightmap.length) return 0
    return sampleHeightVisual(this.heightmap, x, z)
  }

  private terrainSlopeAt(x: number, z: number, headingDeg: number): { pitch: number; roll: number } {
    const eps = 1.2
    const h = this.sampleTerrain(x, z)
    const hx = this.sampleTerrain(x + eps, z)
    const hz = this.sampleTerrain(x, z + eps)
    const dhdx = (hx - h) / eps
    const dhdz = (hz - h) / eps
    const rad = (headingDeg * Math.PI) / 180
    const sinH = Math.sin(rad)
    const cosH = Math.cos(rad)
    const forwardGrad = dhdx * sinH + dhdz * cosH
    const rightGrad = dhdx * cosH - dhdz * sinH
    return { pitch: -Math.atan(forwardGrad), roll: Math.atan(rightGrad) }
  }

  private updateTerrain(snapshot: WorldSnapshot): void {
    if (this.terrainMesh) return
    if (!snapshot.heightmap?.length || !snapshot.heightmapSize || !snapshot.worldSize) return

    const { heightmap, heightmapSize, worldSize } = snapshot
    this.heightmap = heightmap
    this.heightmapSize = heightmapSize
    this.worldSize = worldSize
    const geo = new THREE.PlaneGeometry(worldSize, worldSize, heightmapSize - 1, heightmapSize - 1)
    geo.rotateX(-Math.PI / 2)

    const positions = geo.attributes.position
    for (let i = 0; i < positions.count; i++) {
      positions.setY(i, heightAtVertexIndex(i, heightmap, heightmapSize))
    }
    geo.computeVertexNormals()
    geo.computeBoundingBox()
    geo.computeBoundingSphere()

    const count = positions.count
    const colors = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      const h = positions.getY(i)
      const t = Math.min(1, h / 12)
      colors[i * 3] = 0.55 + t * 0.2
      colors[i * 3 + 1] = 0.22 + t * 0.05
      colors[i * 3 + 2] = 0.05
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 })
    this.terrainMesh = new THREE.Mesh(geo, mat)
    this.terrainMesh.position.set(worldSize / 2, 0, worldSize / 2)
    this.terrainMesh.receiveShadow = true
    this.scene.add(this.terrainMesh)
  }

  private updateRover(snapshot: WorldSnapshot): void {
    const { pose } = snapshot.rover
    const surfaceY = this.sampleTerrain(pose.x, pose.z)
    this.roverMesh.position.set(pose.x, surfaceY + ROVER_GROUND_OFFSET, pose.z)
    const { pitch, roll } = this.terrainSlopeAt(pose.x, pose.z, pose.heading_deg)
    this.roverMesh.rotation.order = 'YXZ'
    this.roverMesh.rotation.y = (pose.heading_deg * Math.PI) / 180
    this.roverMesh.rotation.x = pitch
    this.roverMesh.rotation.z = roll
  }

  private updateLandmarks(snapshot: WorldSnapshot): void {
    const seen = new Set<string>()

    for (const lm of snapshot.landmarks) {
      seen.add(lm.id)
      this.landmarkInfo.set(lm.id, lm)

      if (!this.landmarkMeshes.has(lm.id)) {
        const obj = this.buildLandmarkMesh(lm.type, lm.radius)
        obj.traverse(child => {
          if (child instanceof THREE.Mesh) this.meshToLandmarkId.set(child.id, lm.id)
        })
        this.scene.add(obj)
        this.landmarkMeshes.set(lm.id, obj)
      }
      const obj = this.landmarkMeshes.get(lm.id)!
      const terrainY = this.sampleTerrain(lm.x, lm.z)
      obj.position.set(lm.x, terrainY, lm.z)
    }

    for (const [id, obj] of this.landmarkMeshes) {
      if (!seen.has(id)) {
        obj.traverse(child => {
          if (child instanceof THREE.Mesh) this.meshToLandmarkId.delete(child.id)
        })
        this.scene.remove(obj)
        this.landmarkMeshes.delete(id)
        this.landmarkInfo.delete(id)
      }
    }
  }

  private buildLandmarkMesh(type: string, radius: number): THREE.Object3D {
    const color = LANDMARK_COLORS[type] ?? 0x888888
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.2 })

    if (type === 'spire') {
      const g = new THREE.Group()
      const cone = new THREE.Mesh(new THREE.ConeGeometry(radius * 0.6, radius * 3, 6), mat)
      cone.position.y = radius * 1.5
      g.add(cone)
      return g
    }
    if (type === 'crater') {
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(radius * 0.5, radius, 24),
        new THREE.MeshStandardMaterial({ color, side: THREE.DoubleSide }),
      )
      ring.rotation.x = -Math.PI / 2
      ring.position.y = 0.1
      return ring
    }
    if (type === 'beacon') {
      const g = new THREE.Group()
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 3), mat)
      pole.position.y = 1.5
      const light = new THREE.PointLight(0x00ffff, 2, 30)
      light.position.y = 3.2
      g.add(pole, light)
      return g
    }
    if (type === 'base') {
      const g = new THREE.Group()
      const box = new THREE.Mesh(new THREE.BoxGeometry(radius, 3, radius), mat)
      box.position.y = 1.5
      g.add(box)
      return g
    }
    if (type === 'relay') {
      const g = new THREE.Group()
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 5), mat)
      pole.position.y = 2.5
      const dish = new THREE.Mesh(new THREE.SphereGeometry(1.5, 8, 4, 0, Math.PI), mat)
      dish.position.y = 5.5
      dish.rotation.x = Math.PI / 2
      g.add(pole, dish)
      return g
    }
    // rock / tool: sphere sitting on terrain (half-buried for natural look)
    const size = Math.max(0.8, radius)
    const g = new THREE.Group()
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(size, 10, 7), mat)
    sphere.position.y = size * 0.55
    g.add(sphere)
    return g
  }

  private updatePath(snapshot: WorldSnapshot): void {
    const { pose } = snapshot.rover
    const last = this.pathPoints[this.pathPoints.length - 1]
    if (!last || Math.hypot(last.x - pose.x, last.z - pose.z) > 1.5) {
      const pathY = this.sampleTerrain(pose.x, pose.z) + ROVER_GROUND_OFFSET + 0.1
      this.pathPoints.push(new THREE.Vector3(pose.x, pathY, pose.z))
      if (this.pathPoints.length > 500) this.pathPoints.shift()
      if (this.pathLine) this.scene.remove(this.pathLine)
      const geo = new THREE.BufferGeometry().setFromPoints(this.pathPoints)
      this.pathLine = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: 0xff6622, opacity: 0.6, transparent: true }),
      )
      this.scene.add(this.pathLine)
    }
  }

  private updateOrbitTarget(snapshot: WorldSnapshot): void {
    const { pose } = snapshot.rover
    const roverWorldY = this.sampleTerrain(pose.x, pose.z) + ROVER_GROUND_OFFSET + 0.6
    const target = new THREE.Vector3(pose.x, roverWorldY, pose.z)
    this.controls.target.lerp(target, 0.08)
  }

  dispose(): void {
    cancelAnimationFrame(this.animFrame)
    this.controls.dispose()
    if (this.povRenderer) {
      this.povRenderer.dispose()
      this.povRenderer = null
    }
    if (this.povCaptureRenderer) {
      this.povCaptureRenderer.dispose()
      this.povCaptureRenderer = null
    }
    this.renderer.dispose()
  }
}
