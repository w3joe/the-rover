import type { CollectedArtifact, MissionReview, WorldSnapshot } from '@mars/shared'

const MINERAL_COLORS: Record<string, string> = {
  basalt: '#6a4a3a',
  sedimentary: '#c9a060',
  volcanic: '#8b2020',
  unknown: '#555555',
}

const REPAIR_LABELS: Record<string, string> = {
  assessed: 'Damage assessed',
  coupling_fixed: 'Coupling repaired',
  repaired: 'Relay operational',
}

function formatSolTime(sol: number, solMinute: number): string {
  const h = String(Math.floor(solMinute / 60)).padStart(2, '0')
  const m = String(solMinute % 60).padStart(2, '0')
  return `Sol ${sol} ${h}:${m}`
}

function artifactTitle(a: CollectedArtifact): string {
  switch (a.kind) {
    case 'photograph':
      return `Photograph — ${a.landmarkId}`
    case 'sample':
      return `Sample — ${a.rockId}`
    case 'repair':
      return `Repair — ${a.landmarkId}`
    case 'waypoint':
      return a.objectiveKind === 'return_to_base' ? `Return — ${a.landmarkId}` : `Waypoint — ${a.landmarkId}`
  }
}

function renderArtifactCard(a: CollectedArtifact): HTMLElement {
  const card = document.createElement('article')
  card.className = 'review-card'

  const header = document.createElement('div')
  header.className = 'review-card-header'
  const kind = document.createElement('span')
  kind.className = `review-kind review-kind-${a.kind}`
  kind.textContent = a.kind
  const title = document.createElement('h3')
  title.textContent = artifactTitle(a)
  const time = document.createElement('span')
  time.className = 'review-time'
  time.textContent = formatSolTime(a.sol, a.solMinute)
  header.append(kind, title, time)
  card.appendChild(header)

  const body = document.createElement('div')
  body.className = 'review-card-body'

  switch (a.kind) {
    case 'photograph': {
      if (a.imageBase64) {
        const img = document.createElement('img')
        img.className = 'review-photo'
        img.alt = `Photograph of ${a.landmarkId}`
        img.src = `data:image/png;base64,${a.imageBase64}`
        body.appendChild(img)
      } else {
        const placeholder = document.createElement('div')
        placeholder.className = 'review-photo-placeholder'
        placeholder.textContent = 'No image captured'
        body.appendChild(placeholder)
      }
      const meta = document.createElement('p')
      meta.className = 'review-meta'
      meta.textContent = `Target type: ${a.landmarkType}`
      body.appendChild(meta)
      break
    }
    case 'sample': {
      const swatch = document.createElement('div')
      swatch.className = 'review-sample-swatch'
      swatch.style.background = MINERAL_COLORS[a.mineral] ?? MINERAL_COLORS.unknown
      const info = document.createElement('div')
      info.className = 'review-sample-info'
      info.innerHTML = `
        <div class="review-sample-mineral">${a.mineral}</div>
        <div class="review-meta">Rock ID: ${a.rockId}</div>
        <div class="review-meta">Tags: ${a.tags.join(', ') || '—'}</div>
      `
      const row = document.createElement('div')
      row.className = 'review-sample-row'
      row.append(swatch, info)
      body.appendChild(row)
      break
    }
    case 'repair': {
      const status = document.createElement('p')
      status.className = 'review-repair-status'
      status.textContent = REPAIR_LABELS[a.action] ?? a.action
      body.appendChild(status)
      if (a.issues?.length) {
        const issues = document.createElement('p')
        issues.className = 'review-meta'
        issues.textContent = `Issues found: ${a.issues.join(', ')}`
        body.appendChild(issues)
      }
      break
    }
    case 'waypoint': {
      const meta = document.createElement('p')
      meta.className = 'review-meta'
      meta.textContent =
        a.objectiveKind === 'return_to_base'
          ? 'Rover returned to base within mission parameters.'
          : 'Rover reached landmark within mission parameters.'
      body.appendChild(meta)
      break
    }
  }

  card.appendChild(body)
  return card
}

function ensureReviewOverlay(): HTMLElement {
  let overlay = document.getElementById('review-overlay')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'review-overlay'
    overlay.className = 'hidden'
    document.body.appendChild(overlay)
  }
  return overlay
}

export function showMissionReview(review: MissionReview, onClose: () => void): void {
  const overlay = ensureReviewOverlay()
  overlay.innerHTML = ''
  overlay.classList.remove('hidden')

  const panel = document.createElement('div')
  panel.className = 'review-panel'

  const header = document.createElement('div')
  header.className = 'review-header'
  const elapsedSec = (review.elapsed_ms / 1000).toFixed(0)
  header.innerHTML = `
    <h1>Mission Review</h1>
    <p class="review-subtitle">${review.missionName} — ${review.steps} steps, ${elapsedSec}s</p>
    <p class="review-desc">Data collected during the mission.</p>
  `

  const grid = document.createElement('div')
  grid.className = 'review-grid'

  if (!review.artifacts.length) {
    const empty = document.createElement('p')
    empty.className = 'review-empty'
    empty.textContent = 'No artifacts were recorded for this mission.'
    grid.appendChild(empty)
  } else {
    for (const artifact of review.artifacts) {
      grid.appendChild(renderArtifactCard(artifact))
    }
  }

  const footer = document.createElement('div')
  footer.className = 'review-footer'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'setup-btn setup-btn-secondary'
  closeBtn.textContent = 'Close'
  closeBtn.onclick = () => hideMissionReview()

  const newBtn = document.createElement('button')
  newBtn.type = 'button'
  newBtn.className = 'setup-btn setup-btn-primary'
  newBtn.textContent = 'New mission'
  newBtn.onclick = () => {
    hideMissionReview()
    onClose()
  }

  footer.append(closeBtn, newBtn)
  panel.append(header, grid, footer)
  overlay.appendChild(panel)
}

export function hideMissionReview(): void {
  ensureReviewOverlay().classList.add('hidden')
}

/** Build a minimal review from the last world snapshot when the server omits review payload. */
export function buildReviewFromSnapshot(
  snapshot: WorldSnapshot,
  steps: number,
  elapsed_ms: number,
): MissionReview {
  const { rover, mission } = snapshot
  const stamp = { sol: rover.sol, solMinute: rover.sol_minute }
  const artifacts: CollectedArtifact[] = []

  for (const id of rover.inventory.photos) {
    const lm = snapshot.landmarks.find(l => l.id === id)
    artifacts.push({
      kind: 'photograph',
      landmarkId: id,
      landmarkType: lm?.type ?? 'rock',
      ...stamp,
    })
  }
  rover.inventory.samples.forEach((id, i) => {
    const mineral = rover.inventory.sampleMinerals[i] ?? 'unknown'
    artifacts.push({
      kind: 'sample',
      rockId: id,
      mineral,
      tags: [],
      ...stamp,
    })
  })

  return {
    missionName: mission.name,
    steps,
    elapsed_ms,
    artifacts,
  }
}
