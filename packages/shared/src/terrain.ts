export const HEIGHTMAP_SIZE = 64
export const WORLD_SIZE = 200
/** Client Three.js mesh displaces heights by this factor (server logic uses raw heights). */
export const TERRAIN_VISUAL_SCALE = 1.5
/** Max |Δheight| / horizontal distance the rover can climb per move step. */
export const MAX_TRAVERSABLE_SLOPE = 0.55

export function heightmapIndex(ix: number, iz: number, n = HEIGHTMAP_SIZE): number {
  return ix * n + iz
}

/** PlaneGeometry vertex order is iz * n + ix; heightmap storage is ix * n + iz. */
export function heightAtVertexIndex(
  vertIdx: number,
  heights: number[],
  n = HEIGHTMAP_SIZE,
  scale = TERRAIN_VISUAL_SCALE,
): number {
  const iz = Math.floor(vertIdx / n)
  const ix = vertIdx % n
  return (heights[heightmapIndex(ix, iz, n)] ?? 0) * scale
}

function seededRng(seed: number) {
  let s = seed
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff
    return (s >>> 0) / 0xffffffff
  }
}

export function generateHeightmap(seed = 42): number[] {
  const rng = seededRng(seed)
  const n = HEIGHTMAP_SIZE
  const heights = new Array<number>(n * n)

  const layers = [
    { freq: 0.03, amp: 4.0 },
    { freq: 0.07, amp: 2.0 },
    { freq: 0.15, amp: 1.0 },
    { freq: 0.30, amp: 0.4 },
  ]
  const offsets = layers.map(() => ({ ox: rng() * 200, oz: rng() * 200 }))

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      let h = 4.0
      for (let l = 0; l < layers.length; l++) {
        const { freq, amp } = layers[l]
        const { ox, oz } = offsets[l]
        h += Math.sin((i + ox) * freq) * Math.cos((j + oz) * freq) * amp
      }
      heights[heightmapIndex(i, j, n)] = Math.max(0, h)
    }
  }
  return heights
}

export function sampleHeight(heights: number[], x: number, z: number): number {
  const n = HEIGHTMAP_SIZE
  const cx = Math.max(0, Math.min(n - 1, (x / WORLD_SIZE) * (n - 1)))
  const cz = Math.max(0, Math.min(n - 1, (z / WORLD_SIZE) * (n - 1)))
  const ix = Math.floor(cx)
  const iz = Math.floor(cz)
  const fx = cx - ix
  const fz = cz - iz
  const i0 = Math.min(ix, n - 2)
  const i1 = i0 + 1
  const j0 = Math.min(iz, n - 2)
  const j1 = j0 + 1
  const h00 = heights[heightmapIndex(i0, j0, n)]
  const h10 = heights[heightmapIndex(i1, j0, n)]
  const h01 = heights[heightmapIndex(i0, j1, n)]
  const h11 = heights[heightmapIndex(i1, j1, n)]
  return h00 * (1 - fx) * (1 - fz) + h10 * fx * (1 - fz) + h01 * (1 - fx) * fz + h11 * fx * fz
}

export function sampleHeightVisual(heights: number[], x: number, z: number): number {
  return sampleHeight(heights, x, z) * TERRAIN_VISUAL_SCALE
}
