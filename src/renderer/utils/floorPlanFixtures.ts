/**
 * Fixture preset library — placeable decor / architectural glyphs.
 *
 * COPY of admin-dashboard/src/features/floor-plan/fixtures.ts (the canonical
 * source): the POS 2D modal renders the same glyphs the admin editor places,
 * so the floor picture matches everywhere. Keep additions in sync with the
 * admin file.
 */

import { createElement, Fragment, type ReactNode } from 'react';

export type FixtureCategory = 'kitchen' | 'bar' | 'bathroom' | 'door' | 'decor' | 'storage';

export interface FixturePreset {
  id: string;
  /** i18n key for the fixture's display name. */
  nameKey: string;
  /** English fallback. */
  nameFallback: string;
  /** Default footprint in canvas pixels when newly placed. */
  defaultWidth: number;
  defaultHeight: number;
  /** Background fill color of the glyph rectangle. */
  bgColor: string;
  /** Stroke color for the rectangle border + glyph lines. */
  strokeColor: string;
  /** Category used to group fixtures in the palette. */
  category: FixtureCategory;
  /**
   * Render the fixture's interior glyph. The wrapping `<rect>` background
   * + border is provided by the canvas; this function returns whatever
   * additional SVG primitives represent the fixture (stove tops, sink
   * basin, plant fronds, etc.). Coordinates are local: 0,0 is the
   * top-left of the fixture, w,h are the (already scaled) dimensions.
   */
  renderGlyph: (w: number, h: number) => ReactNode;
}

// ---------------------------------------------------------------------------
// Glyph helpers
// ---------------------------------------------------------------------------

const e = createElement;

function lineEl(x1: number, y1: number, x2: number, y2: number, stroke: string, strokeWidth = 2) {
  return e('line', { x1, y1, x2, y2, stroke, strokeWidth, strokeLinecap: 'round' as const });
}

function circleEl(cx: number, cy: number, r: number, stroke: string, fill = 'none', strokeWidth = 2) {
  return e('circle', { cx, cy, r, stroke, fill, strokeWidth });
}

function rectEl(x: number, y: number, w: number, h: number, stroke: string, fill = 'none', strokeWidth = 2) {
  return e('rect', { x, y, width: w, height: h, stroke, fill, strokeWidth });
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const FIXTURE_PRESETS: FixturePreset[] = [
  {
    id: 'kitchen_counter',
    nameKey: 'floorPlan.fixtures.kitchenCounter',
    nameFallback: 'Kitchen counter',
    defaultWidth: 200,
    defaultHeight: 80,
    bgColor: '#f3f4f6',
    strokeColor: '#374151',
    category: 'kitchen',
    renderGlyph: (w, h) =>
      e(
        Fragment,
        null,
        // Two burners on the left half
        circleEl(w * 0.18, h * 0.5, Math.min(w, h) * 0.12, '#374151'),
        circleEl(w * 0.42, h * 0.5, Math.min(w, h) * 0.12, '#374151'),
        // Sink area on the right half
        rectEl(w * 0.6, h * 0.2, w * 0.32, h * 0.6, '#374151', '#e5e7eb'),
        circleEl(w * 0.76, h * 0.5, Math.min(w * 0.32, h * 0.6) * 0.18, '#374151'),
      ),
  },
  {
    id: 'bar',
    nameKey: 'floorPlan.fixtures.bar',
    nameFallback: 'Bar counter',
    defaultWidth: 220,
    defaultHeight: 60,
    bgColor: '#fde68a',
    strokeColor: '#92400e',
    category: 'bar',
    renderGlyph: (w, h) =>
      e(
        Fragment,
        null,
        // Inner counter line
        lineEl(0, h * 0.7, w, h * 0.7, '#92400e', 2),
        // Stool indicators along the front edge
        ...Array.from({ length: Math.max(1, Math.floor(w / 50)) }).map((_, i) =>
          circleEl(25 + i * 50, h - 8, 6, '#92400e', '#fde68a'),
        ),
      ),
  },
  {
    id: 'toilet',
    nameKey: 'floorPlan.fixtures.toilet',
    nameFallback: 'Toilet',
    defaultWidth: 60,
    defaultHeight: 80,
    bgColor: '#ffffff',
    strokeColor: '#1f2937',
    category: 'bathroom',
    renderGlyph: (w, h) =>
      e(
        Fragment,
        null,
        // Tank
        rectEl(w * 0.15, 4, w * 0.7, h * 0.25, '#1f2937'),
        // Bowl (rounded)
        e('ellipse', {
          cx: w / 2,
          cy: h * 0.6,
          rx: w * 0.35,
          ry: h * 0.3,
          stroke: '#1f2937',
          fill: 'none',
          strokeWidth: 2,
        }),
      ),
  },
  {
    id: 'sink',
    nameKey: 'floorPlan.fixtures.sink',
    nameFallback: 'Sink',
    defaultWidth: 70,
    defaultHeight: 50,
    bgColor: '#ffffff',
    strokeColor: '#1f2937',
    category: 'bathroom',
    renderGlyph: (w, h) =>
      e(
        Fragment,
        null,
        rectEl(w * 0.1, h * 0.2, w * 0.8, h * 0.7, '#1f2937', '#e5e7eb'),
        circleEl(w / 2, h * 0.55, 3, '#1f2937', '#1f2937'),
      ),
  },
  {
    id: 'plant',
    nameKey: 'floorPlan.fixtures.plant',
    nameFallback: 'Plant',
    defaultWidth: 50,
    defaultHeight: 50,
    bgColor: '#ecfdf5',
    strokeColor: '#047857',
    category: 'decor',
    renderGlyph: (w, h) =>
      e(
        Fragment,
        null,
        // Pot
        e('path', {
          d: `M ${w * 0.2} ${h * 0.65} L ${w * 0.8} ${h * 0.65} L ${w * 0.7} ${h * 0.95} L ${w * 0.3} ${h * 0.95} Z`,
          fill: '#a16207',
          stroke: '#047857',
          strokeWidth: 1.5,
        }),
        // Foliage circles
        circleEl(w * 0.5, h * 0.35, h * 0.18, '#047857', '#10b981'),
        circleEl(w * 0.32, h * 0.5, h * 0.13, '#047857', '#10b981'),
        circleEl(w * 0.68, h * 0.5, h * 0.13, '#047857', '#10b981'),
      ),
  },
  {
    id: 'window',
    nameKey: 'floorPlan.fixtures.window',
    nameFallback: 'Window',
    defaultWidth: 100,
    defaultHeight: 16,
    bgColor: '#ffffff',
    strokeColor: '#1f2937',
    category: 'door',
    renderGlyph: (w, h) =>
      e(
        Fragment,
        null,
        // The architectural symbol for a window: rectangle with two
        // parallel lines marking the inner glass plane.
        lineEl(0, h * 0.33, w, h * 0.33, '#1f2937', 1),
        lineEl(0, h * 0.66, w, h * 0.66, '#1f2937', 1),
      ),
  },
  {
    id: 'door',
    nameKey: 'floorPlan.fixtures.door',
    nameFallback: 'Door',
    defaultWidth: 80,
    defaultHeight: 80,
    bgColor: 'transparent',
    strokeColor: '#1f2937',
    category: 'door',
    renderGlyph: (w, h) =>
      e(
        Fragment,
        null,
        // Door panel (line from corner)
        lineEl(0, 0, w * 0.9, 0, '#1f2937', 3),
        // Swing arc
        e('path', {
          d: `M ${w * 0.9} 0 A ${w * 0.9} ${h * 0.9} 0 0 1 0 ${h * 0.9}`,
          fill: 'none',
          stroke: '#1f2937',
          strokeWidth: 1.5,
          strokeDasharray: '4 4',
        }),
      ),
  },
  {
    id: 'wardrobe',
    nameKey: 'floorPlan.fixtures.wardrobe',
    nameFallback: 'Wardrobe',
    defaultWidth: 120,
    defaultHeight: 50,
    bgColor: '#fef3c7',
    strokeColor: '#92400e',
    category: 'storage',
    renderGlyph: (w, h) =>
      e(
        Fragment,
        null,
        // Internal divider
        lineEl(w * 0.5, 0, w * 0.5, h, '#92400e', 1.5),
        // Hangers indicator (small circles)
        circleEl(w * 0.25, h * 0.5, 3, '#92400e', '#92400e'),
        circleEl(w * 0.75, h * 0.5, 3, '#92400e', '#92400e'),
      ),
  },
]

export function getFixturePreset(id: string): FixturePreset | undefined {
  return FIXTURE_PRESETS.find((p) => p.id === id);
}

export function fixturesByCategory(): Record<FixtureCategory, FixturePreset[]> {
  const out: Record<FixtureCategory, FixturePreset[]> = {
    kitchen: [],
    bar: [],
    bathroom: [],
    door: [],
    decor: [],
    storage: [],
  };
  for (const f of FIXTURE_PRESETS) {
    out[f.category].push(f);
  }
  return out;
}
