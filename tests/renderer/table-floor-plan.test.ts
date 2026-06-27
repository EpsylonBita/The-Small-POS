import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  getTableFloorPlanBounds,
  getTableFloorPlanLayout,
  getTableShapePathForFloorPlan,
  resolveTableFloorPlanNode,
} from '../../src/renderer/utils/tableFloorPlan'
import { formatTableDisplayNumber } from '../../src/renderer/utils/table-display'
import i18next from 'i18next'

const floorPlanViewSource = readFileSync(
  path.join(process.cwd(), 'src', 'renderer', 'components', 'tables', 'TableFloorPlanView.tsx'),
  'utf8',
)

const localesDir = path.join(process.cwd(), 'src', 'locales')
const loadLocale = (lng: string): Record<string, any> =>
  JSON.parse(readFileSync(path.join(localesDir, `${lng}.json`), 'utf8'))
const createPaxT = async (locale: string) => {
  const instance = i18next.createInstance()
  await instance.init({
    lng: locale,
    fallbackLng: 'en',
    resources: {
      en: { translation: loadLocale('en') },
      el: { translation: loadLocale('el') },
    },
    interpolation: { escapeValue: false },
  })
  return instance.getFixedT(locale)
}

describe('table floor-plan helpers', () => {
  it('uses saved admin coordinates for positioned POS tables', () => {
    const node = resolveTableFloorPlanNode({
      id: 'table-b03',
      tableNumber: 'TB03',
      capacity: 2,
      positionX: 320,
      positionY: 180,
      width: 120,
      height: 80,
      rotation: 30,
      shape: 'circle',
    }, 0)

    assert.equal(node.x, 320)
    assert.equal(node.y, 180)
    assert.equal(node.width, 120)
    assert.equal(node.height, 80)
    assert.equal(node.rotation, 30)
    assert.equal(node.label, 'TB03')
    assert.equal(node.shape, 'circle')
  })

  it('falls back to deterministic positions for unplaced tables', () => {
    const first = resolveTableFloorPlanNode({ id: 'table-1', tableNumber: 'T1' }, 0)
    const second = resolveTableFloorPlanNode({ id: 'table-2', tableNumber: 'T2' }, 1)

    assert.deepEqual(
      { x: first.x, y: first.y },
      { x: 48, y: 48 },
    )
    assert.deepEqual(
      { x: second.x, y: second.y },
      { x: 176, y: 48 },
    )
  })

  it('normalizes the cluster to the padding origin and sizes the canvas around it', () => {
    const tables = [
      { id: 'table-1', tableNumber: 'T1', positionX: 100, positionY: 120 },
      { id: 'table-2', tableNumber: 'T2', positionX: 880, positionY: 640 },
    ]
    const layout = getTableFloorPlanLayout(tables)

    // Nearest table pulled to the padding origin; relative spacing preserved.
    assert.deepEqual({ x: layout.nodes[0].x, y: layout.nodes[0].y }, { x: 48, y: 48 })
    assert.deepEqual({ x: layout.nodes[1].x, y: layout.nodes[1].y }, { x: 828, y: 568 })
    assert.equal(layout.nodes[1].x - layout.nodes[0].x, 780)
    assert.equal(layout.nodes[1].y - layout.nodes[0].y, 520)

    // Bounds wrap the normalized cluster (no huge empty leading space).
    assert.deepEqual(layout.bounds, { width: 956, height: 696 })
    assert.deepEqual(getTableFloorPlanBounds(tables), { width: 956, height: 696 })
  })

  it('pulls a single far-positioned filtered table into the initial viewport', () => {
    // Repro: a narrow filtered set such as only reserved #TP01 at high coords.
    const layout = getTableFloorPlanLayout([
      { id: 'tp01', tableNumber: 'TP01', positionX: 820, positionY: 610 },
    ])

    assert.equal(layout.nodes.length, 1)
    assert.deepEqual({ x: layout.nodes[0].x, y: layout.nodes[0].y }, { x: 48, y: 48 })
    // Far coordinates no longer create leading space; bounds fall back to minimums.
    assert.deepEqual(layout.bounds, { width: 720, height: 480 })
  })

  it('leaves fallback-positioned tables at the padding origin', () => {
    const layout = getTableFloorPlanLayout([
      { id: 'a', tableNumber: 'A' },
      { id: 'b', tableNumber: 'B' },
    ])

    assert.deepEqual({ x: layout.nodes[0].x, y: layout.nodes[0].y }, { x: 48, y: 48 })
    assert.deepEqual({ x: layout.nodes[1].x, y: layout.nodes[1].y }, { x: 176, y: 48 })
  })

  it('returns layout defaults when there are no tables', () => {
    const layout = getTableFloorPlanLayout([])
    assert.equal(layout.nodes.length, 0)
    assert.deepEqual(layout.bounds, { width: 720, height: 480 })
  })

  it('renders distinct SVG paths for round and rectangular tables', () => {
    const roundPath = getTableShapePathForFloorPlan('circle', 84, 76)
    const rectanglePath = getTableShapePathForFloorPlan('rectangle', 84, 76)

    assert.match(roundPath, /a 38,38/)
    assert.equal(rectanglePath, 'M 0,0 L 84,0 L 84,76 L 0,76 Z')
  })
})

describe('table floor-plan display labels', () => {
  it('formats raw P01/TP01 labels consistently as #TP01 (matches list card / TableActionModal)', () => {
    assert.equal(formatTableDisplayNumber('P01'), '#TP01')
    assert.equal(formatTableDisplayNumber('TP01'), '#TP01')
    assert.equal(formatTableDisplayNumber('#TP01'), '#TP01')

    // The previously-shipped ad-hoc floor-plan formatting produced the wrong
    // marker label ("#P01") for the same raw value the modal showed as "#TP01".
    const adHoc = (raw: string) => (String(raw).startsWith('#') ? String(raw) : `#${raw}`)
    assert.equal(adHoc('P01'), '#P01')
    assert.notEqual(adHoc('P01'), formatTableDisplayNumber('P01'))
  })

  it('keeps the raw node label for matching while only the display string is formatted', () => {
    const node = resolveTableFloorPlanNode({ id: 'tp01', tableNumber: 'P01' }, 0)

    // Raw label/tableNumber stays untouched (used for matching/payloads/session).
    assert.equal(node.label, 'P01')

    // Display formatting derives a NEW string without mutating the raw value.
    const display = formatTableDisplayNumber(node.label)
    assert.equal(display, '#TP01')
    assert.equal(node.label, 'P01')
  })

  it('routes the 2D marker visible text, aria-label and title through the shared formatter', () => {
    assert.match(
      floorPlanViewSource,
      /import \{ formatTableDisplayNumber \} from ['"]\.\.\/\.\.\/utils\/table-display['"]/,
    )
    assert.match(floorPlanViewSource, /const label = formatTableDisplayNumber\(node\.label\)/)

    // The single `label` drives the visible SVG text and the shared description
    // used by both aria-label and <title>.
    assert.match(floorPlanViewSource, /const tableDescription = `\$\{label\} \$\{statusLabel\(status\)\}`/)
    assert.match(floorPlanViewSource, /\{label\}\s*<\/text>/)
    assert.match(floorPlanViewSource, /aria-label=\{tableDescription\}/)
    assert.match(floorPlanViewSource, /<title>\{tableDescription\}<\/title>/)

    // The ad-hoc '#' + raw label formatting is gone.
    assert.doesNotMatch(floorPlanViewSource, /`#\$\{node\.label\}`/)
    assert.doesNotMatch(floorPlanViewSource, /String\(node\.label\)\.startsWith\('#'\)/)

    // Marker click still selects the raw table object (display formatting must
    // not change the payload/matching value).
    assert.match(floorPlanViewSource, /onClick=\{\(\) => onTableSelect\(table\)\}/)
  })
})

describe('table floor-plan capacity (pax) label', () => {
  const POS_LOCALES = ['en', 'el', 'de', 'fr', 'it'] as const
  const GREEK_LETTER = new RegExp('[\\u0370-\\u03FF]')

  it('renders the capacity label via the count-aware floorPlan.tableProperties.pax key', () => {
    assert.match(
      floorPlanViewSource,
      /t\('floorPlan\.tableProperties\.pax', \{ count: node\.capacity \?\? table\.capacity/,
    )
    // The once-computed raw paxLabel const and the "{capacity} {paxLabel}" render are gone.
    assert.doesNotMatch(floorPlanViewSource, /const paxLabel =/)
    assert.doesNotMatch(floorPlanViewSource, /\{paxLabel\}/)
  })

  it('floorPlan.tableProperties.pax plural keys exist in every POS locale with {{count}}', () => {
    for (const lng of POS_LOCALES) {
      const tp = loadLocale(lng).floorPlan?.tableProperties ?? {}
      for (const key of ['pax_one', 'pax_other']) {
        assert.equal(typeof tp[key], 'string', `${lng}.floorPlan.tableProperties.${key} missing`)
        assert.ok((tp[key] as string).length > 0, `${lng}.floorPlan.tableProperties.${key} empty`)
        assert.match(tp[key], /\{\{count\}\}/, `${lng}.floorPlan.tableProperties.${key} lost {{count}}`)
      }
    }
  })

  it('Greek 2D capacity label is localized and never shows raw "pax"', async () => {
    const el = await createPaxT('el')
    const one = el('floorPlan.tableProperties.pax', { count: 1 })
    const many = el('floorPlan.tableProperties.pax', { count: 4 })

    assert.match(one, GREEK_LETTER, `el pax (1) should be Greek: "${one}"`)
    assert.match(many, GREEK_LETTER, `el pax (4) should be Greek: "${many}"`)
    assert.ok(!one.includes('pax'), `el pax (1) leaks "pax": "${one}"`)
    assert.ok(!many.includes('pax'), `el pax (4) leaks "pax": "${many}"`)
    // Count-aware: singular vs plural differ and carry the number.
    assert.match(one, /1/)
    assert.match(many, /4/)
    assert.notEqual(one, many)

    // English still renders the compact "pax" unit.
    const enT = await createPaxT('en')
    assert.ok(enT('floorPlan.tableProperties.pax', { count: 2 }).includes('pax'))
  })
})
