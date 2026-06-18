import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  getTableFloorPlanBounds,
  getTableShapePathForFloorPlan,
  resolveTableFloorPlanNode,
} from '../../src/renderer/utils/tableFloorPlan'

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

  it('sizes the canvas around the furthest designed table', () => {
    const bounds = getTableFloorPlanBounds([
      { id: 'table-1', tableNumber: 'T1', positionX: 100, positionY: 120 },
      { id: 'table-2', tableNumber: 'T2', positionX: 880, positionY: 640 },
    ])

    assert.equal(bounds.width, 1008)
    assert.equal(bounds.height, 768)
  })

  it('renders distinct SVG paths for round and rectangular tables', () => {
    const roundPath = getTableShapePathForFloorPlan('circle', 84, 76)
    const rectanglePath = getTableShapePathForFloorPlan('rectangle', 84, 76)

    assert.match(roundPath, /a 38,38/)
    assert.equal(rectanglePath, 'M 0,0 L 84,0 L 84,76 L 0,76 Z')
  })
})
