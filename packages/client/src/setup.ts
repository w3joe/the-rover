import type {
  LandmarkCatalogEntry,
  MissionDef,
  Objective,
  ObjectiveKind,
  StormFrequency,
  WorldConditions,
} from '@mars/shared'

const DEFAULT_CONDITIONS: WorldConditions = {
  seed: 42,
  startBatteryPct: 100,
  startSolMinute: 150,
  stormFrequency: 'normal',
}

const OBJECTIVE_KINDS: ObjectiveKind[] = [
  'reach',
  'collect_samples',
  'photograph',
  'repair',
  'return_to_base',
]

const KIND_LABELS: Record<ObjectiveKind, string> = {
  reach: 'Reach landmark',
  collect_samples: 'Collect samples',
  photograph: 'Photograph',
  repair: 'Repair',
  return_to_base: 'Return to base',
}

type LaunchFn = (mission: MissionDef) => void

let catalog: LandmarkCatalogEntry[] = []
let onLaunch: LaunchFn = () => {}

let customName = 'Custom Mission'
let customObjectives: Objective[] = []
let customConditions: WorldConditions = { ...DEFAULT_CONDITIONS }

let presetsPane: HTMLElement
let customPane: HTMLElement
let objectivesListEl: HTMLElement
let nameInput: HTMLInputElement
let batterySlider: HTMLInputElement
let batteryLabel: HTMLElement
let seedInput: HTMLInputElement
let solMinuteInput: HTMLInputElement
let stormSelect: HTMLSelectElement

function cloneMission(m: MissionDef): MissionDef {
  return structuredClone(m)
}

function describeObjectiveShort(o: Objective): string {
  switch (o.kind) {
    case 'reach':
      return `Reach ${o.landmarkId} (${o.radiusM}m)`
    case 'collect_samples':
      return `Collect ${o.count} sample${o.count === 1 ? '' : 's'}${o.distinctMinerals ? ' (distinct)' : ''}`
    case 'photograph':
      return `Photo ${o.landmarkId}`
    case 'repair':
      return `Repair ${o.landmarkId}`
    case 'return_to_base':
      return `Return to ${o.landmarkId}${o.deadlineSolMinute != null ? ` by min ${o.deadlineSolMinute}` : ''}`
  }
}

function describeConditions(c: WorldConditions): string {
  return `Bat ${c.startBatteryPct}% · Sol min ${c.startSolMinute} · Storms ${c.stormFrequency} · Seed ${c.seed}`
}

function defaultObjective(kind: ObjectiveKind): Objective {
  const base = catalog[0]?.id ?? 'base_station'
  switch (kind) {
    case 'reach':
      return { kind, landmarkId: 'beacon_A', radiusM: 5 }
    case 'collect_samples':
      return { kind, count: 3, distinctMinerals: true }
    case 'photograph':
      return { kind, landmarkId: 'olympus_spire' }
    case 'repair':
      return { kind, landmarkId: 'relay_tower' }
    case 'return_to_base':
      return { kind, landmarkId: base, radiusM: 10 }
  }
}

function landmarkOptions(filter?: (e: LandmarkCatalogEntry) => boolean): string {
  const list = filter ? catalog.filter(filter) : catalog
  return list.map(e => `<option value="${e.id}">${e.id} (${e.type})</option>`).join('')
}

function scrollSetupBodyToTop(): void {
  document.querySelector('.setup-body')?.scrollTo({ top: 0, behavior: 'smooth' })
}

function switchTab(tab: 'presets' | 'custom'): void {
  document.querySelectorAll('.setup-tab').forEach(t => {
    t.classList.toggle('active', (t as HTMLElement).dataset.tab === tab)
  })
  presetsPane.classList.toggle('active', tab === 'presets')
  customPane.classList.toggle('active', tab === 'custom')
  if (tab === 'custom') scrollSetupBodyToTop()
}

function loadIntoBuilder(mission: MissionDef): void {
  customName = mission.name
  customObjectives = mission.objectives.map(o => structuredClone(o))
  customConditions = { ...mission.conditions }
  nameInput.value = customName
  seedInput.value = String(customConditions.seed)
  solMinuteInput.value = String(customConditions.startSolMinute)
  stormSelect.value = customConditions.stormFrequency
  batterySlider.value = String(customConditions.startBatteryPct)
  batteryLabel.textContent = `${customConditions.startBatteryPct}%`
  renderBuilderObjectives()
  switchTab('custom')
  requestAnimationFrame(() => scrollSetupBodyToTop())
}

function hideOverlay(): void {
  document.getElementById('setup-overlay')?.classList.add('hidden')
}

export function showMissionControl(): void {
  document.getElementById('setup-overlay')?.classList.remove('hidden')
}

function launchMission(mission: MissionDef): void {
  if (!mission.objectives.length) {
    alert('Add at least one sub-mission.')
    return
  }
  hideOverlay()
  onLaunch(mission)
}

function readConditions(): WorldConditions {
  return {
    seed: Number(seedInput.value) || 42,
    startBatteryPct: Number(batterySlider.value),
    startSolMinute: Math.min(520, Math.max(0, Number(solMinuteInput.value) || 0)),
    stormFrequency: stormSelect.value as StormFrequency,
  }
}

function readBuilderMission(): MissionDef {
  return {
    name: nameInput.value.trim() || 'Custom Mission',
    objectives: customObjectives.map(o => structuredClone(o)),
    conditions: readConditions(),
  }
}

function renderBuilderObjectives(): void {
  objectivesListEl.innerHTML = ''
  customObjectives.forEach((obj, idx) => {
    const row = document.createElement('div')
    row.className = 'builder-obj-row'

    const header = document.createElement('div')
    header.className = 'builder-obj-header'

    const kindSel = document.createElement('select')
    kindSel.className = 'builder-select'
    OBJECTIVE_KINDS.forEach(k => {
      const opt = document.createElement('option')
      opt.value = k
      opt.textContent = KIND_LABELS[k]
      if (obj.kind === k) opt.selected = true
      kindSel.appendChild(opt)
    })
    kindSel.onchange = () => {
      customObjectives[idx] = defaultObjective(kindSel.value as ObjectiveKind)
      renderBuilderObjectives()
    }

    const upBtn = document.createElement('button')
    upBtn.type = 'button'
    upBtn.className = 'setup-btn setup-btn-ghost'
    upBtn.textContent = '↑'
    upBtn.disabled = idx === 0
    upBtn.onclick = () => {
      if (idx === 0) return
      ;[customObjectives[idx - 1], customObjectives[idx]] = [customObjectives[idx], customObjectives[idx - 1]]
      renderBuilderObjectives()
    }

    const downBtn = document.createElement('button')
    downBtn.type = 'button'
    downBtn.className = 'setup-btn setup-btn-ghost'
    downBtn.textContent = '↓'
    downBtn.disabled = idx === customObjectives.length - 1
    downBtn.onclick = () => {
      if (idx >= customObjectives.length - 1) return
      ;[customObjectives[idx], customObjectives[idx + 1]] = [customObjectives[idx + 1], customObjectives[idx]]
      renderBuilderObjectives()
    }

    const delBtn = document.createElement('button')
    delBtn.type = 'button'
    delBtn.className = 'setup-btn setup-btn-ghost'
    delBtn.textContent = '×'
    delBtn.onclick = () => {
      customObjectives.splice(idx, 1)
      renderBuilderObjectives()
    }

    header.append(kindSel, upBtn, downBtn, delBtn)
    row.appendChild(header)

    const fields = document.createElement('div')
    fields.className = 'builder-obj-fields'

    const addField = (label: string, el: HTMLElement) => {
      const wrap = document.createElement('div')
      wrap.className = 'builder-field'
      const lbl = document.createElement('label')
      lbl.textContent = label
      wrap.append(lbl, el)
      fields.appendChild(wrap)
    }

    if (obj.kind === 'reach' || obj.kind === 'return_to_base') {
      const lmSel = document.createElement('select')
      lmSel.innerHTML = landmarkOptions()
      lmSel.value = obj.landmarkId
      lmSel.onchange = () => { obj.landmarkId = lmSel.value }
      addField('Landmark', lmSel)

      const rad = document.createElement('input')
      rad.type = 'number'
      rad.min = '1'
      rad.value = String(obj.radiusM)
      rad.oninput = () => { obj.radiusM = Number(rad.value) || 5 }
      addField('Radius (m)', rad)

      if (obj.kind === 'return_to_base') {
        const deadline = document.createElement('input')
        deadline.type = 'number'
        deadline.min = '0'
        deadline.max = '520'
        deadline.placeholder = 'optional'
        deadline.value = obj.deadlineSolMinute != null ? String(obj.deadlineSolMinute) : ''
        deadline.oninput = () => {
          const v = deadline.value.trim()
          obj.deadlineSolMinute = v === '' ? undefined : Number(v)
        }
        addField('Deadline (sol min)', deadline)
      }
    } else if (obj.kind === 'collect_samples') {
      const count = document.createElement('input')
      count.type = 'number'
      count.min = '1'
      count.value = String(obj.count)
      count.oninput = () => { obj.count = Math.max(1, Number(count.value) || 1) }
      addField('Count', count)

      const wrap = document.createElement('div')
      wrap.className = 'builder-field'
      const lbl = document.createElement('label')
      lbl.textContent = 'Minerals'
      const chk = document.createElement('label')
      chk.className = 'builder-checkbox'
      const box = document.createElement('input')
      box.type = 'checkbox'
      box.checked = obj.distinctMinerals
      box.onchange = () => { obj.distinctMinerals = box.checked }
      chk.append(box, document.createTextNode(' Distinct types'))
      wrap.append(lbl, chk)
      fields.appendChild(wrap)
    } else if (obj.kind === 'photograph' || obj.kind === 'repair') {
      const lmSel = document.createElement('select')
      const filter = obj.kind === 'photograph'
        ? (e: LandmarkCatalogEntry) => e.type === 'spire' || e.type === 'rock'
        : (e: LandmarkCatalogEntry) => e.type === 'relay'
      lmSel.innerHTML = landmarkOptions(filter)
      if (!Array.from(lmSel.options).some(o => o.value === obj.landmarkId)) {
        lmSel.innerHTML = landmarkOptions() + lmSel.innerHTML
      }
      lmSel.value = obj.landmarkId
      lmSel.onchange = () => { obj.landmarkId = lmSel.value }
      addField('Landmark', lmSel)
    }

    row.appendChild(fields)
    objectivesListEl.appendChild(row)
  })
}

function buildPresetsPane(presets: MissionDef[]): HTMLElement {
  const pane = document.createElement('div')
  pane.className = 'setup-pane active'
  pane.dataset.pane = 'presets'

  const grid = document.createElement('div')
  grid.className = 'preset-grid'

  for (const preset of presets) {
    const card = document.createElement('div')
    card.className = 'preset-card'

    const h3 = document.createElement('h3')
    h3.textContent = preset.name

    const meta = document.createElement('div')
    meta.className = 'preset-meta'
    meta.textContent = describeConditions(preset.conditions)

    const objs = document.createElement('div')
    objs.className = 'preset-objectives'
    objs.innerHTML = preset.objectives
      .map((o, i) => `${i + 1}. ${describeObjectiveShort(o)}`)
      .join('<br>')

    const actions = document.createElement('div')
    actions.className = 'preset-actions'

    const launchBtn = document.createElement('button')
    launchBtn.type = 'button'
    launchBtn.className = 'setup-btn setup-btn-primary'
    launchBtn.textContent = 'Launch'
    launchBtn.onclick = () => launchMission(cloneMission(preset))

    const editBtn = document.createElement('button')
    editBtn.type = 'button'
    editBtn.className = 'setup-btn setup-btn-secondary'
    editBtn.textContent = 'Edit'
    editBtn.onclick = () => loadIntoBuilder(preset)

    actions.append(launchBtn, editBtn)
    card.append(h3, meta, objs, actions)
    grid.appendChild(card)
  }

  pane.appendChild(grid)
  return pane
}

function buildCustomPane(): HTMLElement {
  const pane = document.createElement('div')
  pane.className = 'setup-pane'
  pane.dataset.pane = 'custom'

  const nameSec = document.createElement('div')
  nameSec.className = 'builder-section'
  const nameLbl = document.createElement('label')
  nameLbl.textContent = 'Mission name'
  nameInput = document.createElement('input')
  nameInput.className = 'builder-input'
  nameInput.value = customName
  nameInput.oninput = () => { customName = nameInput.value }
  nameSec.append(nameLbl, nameInput)

  const objSec = document.createElement('div')
  objSec.className = 'builder-section'
  const objHdr = document.createElement('div')
  objHdr.className = 'objectives-builder-header'
  const objLbl = document.createElement('label')
  objLbl.textContent = 'Sub-missions (ordered)'
  const addBtn = document.createElement('button')
  addBtn.type = 'button'
  addBtn.className = 'setup-btn setup-btn-secondary'
  addBtn.textContent = '+ Add sub-mission'
  addBtn.onclick = () => {
    customObjectives.push(defaultObjective('reach'))
    renderBuilderObjectives()
  }
  objHdr.append(objLbl, addBtn)
  objectivesListEl = document.createElement('div')
  objectivesListEl.className = 'objectives-builder-list'
  objSec.append(objHdr, objectivesListEl)

  const condSec = document.createElement('div')
  condSec.className = 'builder-section'
  const condLbl = document.createElement('label')
  condLbl.textContent = 'World conditions'
  const condGrid = document.createElement('div')
  condGrid.className = 'conditions-grid'

  const seedWrap = document.createElement('div')
  seedWrap.className = 'builder-field'
  seedWrap.innerHTML = '<label>Seed</label>'
  seedInput = document.createElement('input')
  seedInput.type = 'number'
  seedInput.className = 'builder-input'
  seedInput.value = String(customConditions.seed)
  seedWrap.appendChild(seedInput)

  const solWrap = document.createElement('div')
  solWrap.className = 'builder-field'
  solWrap.innerHTML = '<label>Start sol minute (0–520)</label>'
  solMinuteInput = document.createElement('input')
  solMinuteInput.type = 'number'
  solMinuteInput.min = '0'
  solMinuteInput.max = '520'
  solMinuteInput.className = 'builder-input'
  solMinuteInput.value = String(customConditions.startSolMinute)
  solWrap.appendChild(solMinuteInput)

  const stormWrap = document.createElement('div')
  stormWrap.className = 'builder-field'
  stormWrap.innerHTML = '<label>Storm frequency</label>'
  stormSelect = document.createElement('select')
  stormSelect.className = 'builder-select'
  ;(['none', 'low', 'normal', 'high'] as StormFrequency[]).forEach(s => {
    const opt = document.createElement('option')
    opt.value = s
    opt.textContent = s
    stormSelect.appendChild(opt)
  })
  stormSelect.value = customConditions.stormFrequency
  stormWrap.appendChild(stormSelect)

  const batWrap = document.createElement('div')
  batWrap.className = 'builder-field full-width'
  const batLbl = document.createElement('label')
  batLbl.textContent = 'Start battery'
  const batRow = document.createElement('div')
  batRow.className = 'battery-row'
  batterySlider = document.createElement('input')
  batterySlider.type = 'range'
  batterySlider.min = '10'
  batterySlider.max = '100'
  batterySlider.value = String(customConditions.startBatteryPct)
  batteryLabel = document.createElement('span')
  batteryLabel.className = 'battery-value'
  batteryLabel.textContent = `${customConditions.startBatteryPct}%`
  batterySlider.oninput = () => {
    batteryLabel.textContent = `${batterySlider.value}%`
  }
  batRow.append(batterySlider, batteryLabel)
  batWrap.append(batLbl, batRow)

  condGrid.append(seedWrap, solWrap, stormWrap, batWrap)
  condSec.append(condLbl, condGrid)

  const footer = document.createElement('div')
  footer.className = 'builder-footer'
  const launchCustom = document.createElement('button')
  launchCustom.type = 'button'
  launchCustom.className = 'setup-btn setup-btn-primary'
  launchCustom.textContent = 'Launch custom mission'
  launchCustom.onclick = () => launchMission(readBuilderMission())
  footer.appendChild(launchCustom)

  pane.append(nameSec, objSec, condSec, footer)
  return pane
}

export function initSetup(
  presets: MissionDef[],
  landmarkCatalog: LandmarkCatalogEntry[],
  launch: LaunchFn,
): void {
  catalog = landmarkCatalog
  onLaunch = launch

  const overlay = document.getElementById('setup-overlay')!
  overlay.innerHTML = ''
  overlay.classList.remove('hidden')

  customObjectives = []
  customConditions = { ...DEFAULT_CONDITIONS }
  customName = 'Custom Mission'

  const panel = document.createElement('div')
  panel.className = 'setup-panel'

  const header = document.createElement('div')
  header.className = 'setup-header'
  header.innerHTML = `
    <h1>Mission Control</h1>
    <p>Select a preset or build a custom mission by adding sub-missions for the rover agent.</p>
  `

  const tabs = document.createElement('div')
  tabs.className = 'setup-tabs'

  const presetsTab = document.createElement('button')
  presetsTab.type = 'button'
  presetsTab.className = 'setup-tab active'
  presetsTab.dataset.tab = 'presets'
  presetsTab.textContent = 'Presets'
  presetsTab.onclick = () => switchTab('presets')

  const customTab = document.createElement('button')
  customTab.type = 'button'
  customTab.className = 'setup-tab'
  customTab.dataset.tab = 'custom'
  customTab.textContent = 'Custom'
  customTab.onclick = () => switchTab('custom')

  tabs.append(presetsTab, customTab)

  const body = document.createElement('div')
  body.className = 'setup-body'
  presetsPane = buildPresetsPane(presets)
  customPane = buildCustomPane()
  body.append(presetsPane, customPane)

  panel.append(header, tabs, body)
  overlay.appendChild(panel)

  renderBuilderObjectives()
}
