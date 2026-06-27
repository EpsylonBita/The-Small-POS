export const FLOOR_PLAN_TABLE_WIDTH = 80;
export const FLOOR_PLAN_TABLE_HEIGHT = 80;
export const FLOOR_PLAN_PADDING = 48;
const FALLBACK_TABLE_GAP_X = 128;
const FALLBACK_TABLE_GAP_Y = 116;
const FALLBACK_COLUMNS = 6;

export interface FloorPlanTableLike {
  id?: string | null;
  tableNumber?: string | number | null;
  table_number?: string | number | null;
  capacity?: number | string | null;
  positionX?: number | string | null;
  positionY?: number | string | null;
  position_x?: number | string | null;
  position_y?: number | string | null;
  width?: number | string | null;
  height?: number | string | null;
  rotation?: number | string | null;
  shape?: string | null;
}

export interface ResolvedTableFloorPlanNode {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  capacity: number | null;
  shape: string;
  isPositioned: boolean;
}

function readFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function fallbackPosition(index: number) {
  return {
    x: FLOOR_PLAN_PADDING + (index % FALLBACK_COLUMNS) * FALLBACK_TABLE_GAP_X,
    y: FLOOR_PLAN_PADDING + Math.floor(index / FALLBACK_COLUMNS) * FALLBACK_TABLE_GAP_Y,
  };
}

export function resolveTableFloorPlanNode(
  table: FloorPlanTableLike,
  index: number,
): ResolvedTableFloorPlanNode {
  const positionedX = readFiniteNumber(table.positionX ?? table.position_x);
  const positionedY = readFiniteNumber(table.positionY ?? table.position_y);
  const width = readFiniteNumber(table.width);
  const height = readFiniteNumber(table.height);
  const rotation = readFiniteNumber(table.rotation);
  const fallback = fallbackPosition(index);
  const label = String(table.tableNumber ?? table.table_number ?? index + 1).trim();
  const capacity = readFiniteNumber(table.capacity);

  return {
    id: String((table.id ?? label) || index),
    label: label || String(index + 1),
    x: positionedX ?? fallback.x,
    y: positionedY ?? fallback.y,
    width: width === null ? FLOOR_PLAN_TABLE_WIDTH : Math.max(20, width),
    height: height === null ? FLOOR_PLAN_TABLE_HEIGHT : Math.max(20, height),
    rotation: rotation ?? 0,
    capacity: capacity === null ? null : Math.max(0, Math.trunc(capacity)),
    shape: String(table.shape || 'rectangle').trim().toLowerCase(),
    isPositioned: positionedX !== null && positionedY !== null,
  };
}

export interface TableFloorPlanLayout {
  nodes: ResolvedTableFloorPlanNode[];
  bounds: { width: number; height: number };
  offsetX: number;
  offsetY: number;
}

/**
 * Resolve every table to a floor-plan node, then translate the whole cluster so
 * its top-left corner sits at FLOOR_PLAN_PADDING.
 *
 * Tables saved with large admin coordinates - or a narrow filtered set
 * positioned far from the origin (e.g. only a reserved table) - would otherwise
 * leave huge empty leading space, so the 2D viewport opened blank until the user
 * scrolled the inner area. Normalizing keeps the first matching extents inside
 * the initial viewport while preserving every table's relative position (a pure
 * translation, so the layout/shape never changes).
 */
export function getTableFloorPlanLayout(tables: FloorPlanTableLike[]): TableFloorPlanLayout {
  const rawNodes = tables.map((table, index) => resolveTableFloorPlanNode(table, index));
  if (rawNodes.length === 0) {
    return { nodes: [], bounds: { width: 720, height: 480 }, offsetX: 0, offsetY: 0 };
  }

  const offsetX = Math.min(...rawNodes.map(node => node.x)) - FLOOR_PLAN_PADDING;
  const offsetY = Math.min(...rawNodes.map(node => node.y)) - FLOOR_PLAN_PADDING;

  const nodes = rawNodes.map(node => ({
    ...node,
    x: node.x - offsetX,
    y: node.y - offsetY,
  }));

  const maxX = Math.max(...nodes.map(node => node.x + node.width));
  const maxY = Math.max(...nodes.map(node => node.y + node.height));

  return {
    nodes,
    bounds: {
      width: Math.max(720, Math.ceil(maxX + FLOOR_PLAN_PADDING)),
      height: Math.max(480, Math.ceil(maxY + FLOOR_PLAN_PADDING)),
    },
    offsetX,
    offsetY,
  };
}

export function getTableFloorPlanBounds(tables: FloorPlanTableLike[]) {
  return getTableFloorPlanLayout(tables).bounds;
}

export function getTableShapePathForFloorPlan(
  shape: string | null | undefined,
  width: number,
  height: number,
): string {
  switch (String(shape || '').toLowerCase()) {
    case 'circle':
    case 'round': {
      const radius = Math.min(width, height) / 2;
      const cx = width / 2;
      const cy = height / 2;
      return `M ${cx - radius},${cy} a ${radius},${radius} 0 1,0 ${radius * 2},0 a ${radius},${radius} 0 1,0 ${-radius * 2},0`;
    }
    case 'oval': {
      const isSquare = Math.abs(width - height) < 1;
      const rx = isSquare ? width * 0.5 : width / 2;
      const ry = isSquare ? height * 0.3 : height / 2;
      const cx = width / 2;
      const cy = height / 2;
      return `M ${cx - rx},${cy} a ${rx},${ry} 0 1,0 ${rx * 2},0 a ${rx},${ry} 0 1,0 ${-rx * 2},0`;
    }
    case 'booth': {
      const curve = Math.min(width, height) * 0.2;
      return `M ${curve},0 L ${width - curve},0 Q ${width},0 ${width},${curve} L ${width},${height - curve} Q ${width},${height} ${width - curve},${height} L ${curve},${height} Q 0,${height} 0,${height - curve} L 0,${curve} Q 0,0 ${curve},0`;
    }
    case 'rectangle':
    case 'square':
    case 'custom':
    default:
      return `M 0,0 L ${width},0 L ${width},${height} L 0,${height} Z`;
  }
}
