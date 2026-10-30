//! Glyph lookup, metrics and coverage for the raster receipt's embedded fonts.
//!
//! Until 30/10/2026 the raster slip drew its text with rusttype 0.9, which
//! reads fonts through ttf-parser 0.15. Both are unmaintained
//! (RUSTSEC-2021-0140, RUSTSEC-2026-0192). This module computes what they
//! computed, on top of read-fonts:
//! - glyph lookup through the first Unicode `cmap` subtable that maps the
//!   character;
//! - rusttype's pixel-height scale, ascent and `hmtx` advances;
//! - ttf-parser's `glyf` outline walk with its bounding box;
//! - coverage from `ab_glyph_rasterizer`, the rasterizer rusttype drew with.
//!
//! Every slip therefore prints the same pixels as before. Only static
//! TrueType outlines are handled, which is what the embedded Noto Serif fonts
//! are: no CFF, no variations, no legacy `kern` table (a test pins this).

use ab_glyph_rasterizer::{Point, Rasterizer};
use read_fonts::tables::cmap::{Cmap, CmapSubtable, PlatformId};
use read_fonts::tables::glyf::{Anchor, Component, CompositeGlyphFlags, Glyf, Glyph};
use read_fonts::tables::hhea::Hhea;
use read_fonts::tables::hmtx::Hmtx;
use read_fonts::tables::loca::{Loca, LocaGlyph};
use read_fonts::tables::os2::{Os2, SelectionFlags};
use read_fonts::types::{BigEndian, GlyphId};
use read_fonts::{FontRef, ReadError, TableProvider};

/// ttf-parser's limit on nested composite glyphs.
const MAX_COMPONENT_DEPTH: u8 = 32;

pub(crate) struct ReceiptFont {
    cmap: Cmap<'static>,
    hmtx: Hmtx<'static>,
    loca: Loca<'static>,
    glyf: Glyf<'static>,
    ascender: i16,
    descender: i16,
}

impl ReceiptFont {
    pub(crate) fn parse(data: &'static [u8]) -> Result<Self, ReadError> {
        let font = FontRef::new(data)?;
        let (ascender, descender) = vertical_metrics(&font.hhea()?, font.os2().ok().as_ref());
        Ok(Self {
            cmap: font.cmap()?,
            hmtx: font.hmtx()?,
            loca: font.loca(None)?,
            glyf: font.glyf()?,
            ascender,
            descender,
        })
    }

    /// The glyph for `ch`, or 0 (`.notdef`) when the font has none.
    pub(crate) fn glyph_id(&self, ch: char) -> u16 {
        let data = self.cmap.offset_data();
        for record in self.cmap.encoding_records() {
            let Ok(subtable) = record.subtable(data) else {
                continue;
            };
            if !is_unicode_subtable(record.platform_id(), record.encoding_id(), &subtable) {
                continue;
            }
            if let Some(glyph) = subtable.map_codepoint(ch) {
                return u16::try_from(glyph.to_u32()).unwrap_or(0);
            }
        }
        0
    }

    /// The font's ascender at `size_px`, the distance from a line's top to
    /// its baseline.
    pub(crate) fn ascent(&self, size_px: f32) -> f32 {
        f32::from(self.ascender) * self.scale_for_pixel_height(size_px)
    }

    pub(crate) fn advance_width(&self, glyph: u16, size_px: f32) -> f32 {
        let advance = self.hmtx.advance(GlyphId::from(glyph)).unwrap_or(0);
        advance as f32 * self.scale(size_px).0
    }

    /// Rasterises `glyph` at `size_px` with its origin at (`x`, `baseline`).
    /// `plot(x, y, coverage)` is called for every pixel of the glyph's
    /// pixel-aligned bounding box, row by row; a glyph with no outline (a
    /// space) plots nothing.
    pub(crate) fn draw_glyph(
        &self,
        glyph: u16,
        size_px: f32,
        x: f32,
        baseline: f32,
        mut plot: impl FnMut(i32, i32, f32),
    ) {
        let mut path = Vec::new();
        let Some(bounds) = self.outline(glyph, &mut path) else {
            return;
        };
        let (scale_x, scale_y) = self.scale(size_px);

        // rusttype's `pixel_bounds_at`: the fractional position takes part in
        // the floor/ceil so equal sub-pixel offsets round the same way.
        let (x_trunc, x_fract) = (x.trunc() as i32, x.fract());
        let (y_trunc, y_fract) = (baseline.trunc() as i32, baseline.fract());
        let min_x = x_trunc + (f32::from(bounds.x_min) * scale_x + x_fract).floor() as i32;
        let min_y = y_trunc + (-f32::from(bounds.y_max) * scale_y + y_fract).floor() as i32;
        let max_x = x_trunc + (f32::from(bounds.x_max) * scale_x + x_fract).ceil() as i32;
        let max_y = y_trunc + (-f32::from(bounds.y_min) * scale_y + y_fract).ceil() as i32;

        let mut pen = RasterPen::new((max_x - min_x) as usize, (max_y - min_y) as usize);
        let (shift_x, shift_y) = (x - min_x as f32, baseline - min_y as f32);
        let place = |(px, py): (f32, f32)| Point {
            x: px * scale_x + shift_x,
            y: py * -scale_y + shift_y,
        };
        for segment in path {
            match segment {
                PathSegment::MoveTo(p) => pen.move_to(place(p)),
                PathSegment::LineTo(p) => pen.line_to(place(p)),
                PathSegment::QuadTo(c, p) => pen.quad_to(place(c), place(p)),
                PathSegment::Close => pen.close(),
            }
        }
        pen.rasterizer.for_each_pixel_2d(|gx, gy, coverage| {
            plot(min_x + gx as i32, min_y + gy as i32, coverage)
        });
    }

    /// rusttype measures size as the ascender-to-descender height.
    fn scale_for_pixel_height(&self, height: f32) -> f32 {
        let font_height = f32::from(self.ascender) - f32::from(self.descender);
        height / font_height
    }

    /// rusttype's `Scale::uniform(size_px)` as (x, y) factors, computed in the
    /// same order so the floats match bit for bit.
    fn scale(&self, size_px: f32) -> (f32, f32) {
        let scale_y = self.scale_for_pixel_height(size_px);
        let scale_x = scale_y * size_px / size_px;
        (scale_x, scale_y)
    }

    /// ttf-parser's `outline_glyph`: the path in font units and the bounding
    /// box of every point it emitted, or `None` for an empty glyph.
    fn outline(&self, glyph: u16, path: &mut Vec<PathSegment>) -> Option<GlyphBounds> {
        let LocaGlyph::Glyph(data) = self.loca.get(GlyphId::from(glyph), &self.glyf)? else {
            return None;
        };
        let mut builder = OutlineBuilder::new(Transform::IDENTITY, BoundsTracker::new(), path);
        self.outline_into(&data, 0, &mut builder)?;
        builder.bounds.to_glyph_bounds()
    }

    fn outline_into(
        &self,
        glyph: &Glyph<'static>,
        depth: u8,
        builder: &mut OutlineBuilder,
    ) -> Option<()> {
        if depth >= MAX_COMPONENT_DEPTH {
            return None;
        }
        match glyph {
            Glyph::Simple(simple) => {
                let end_points = simple.end_pts_of_contours();
                let total = end_points.last()?.get().checked_add(1)?;
                // A one-point outline is ignored, not an error.
                if total == 1 {
                    return Some(());
                }
                let mut contour_ends = ContourEnds::new(end_points)?;
                for point in simple.points().take(usize::from(total)) {
                    let last = contour_ends.next();
                    builder.push_point(
                        f32::from(point.x),
                        f32::from(point.y),
                        point.on_curve,
                        last,
                    );
                }
            }
            Glyph::Composite(composite) => {
                for component in composite.components() {
                    // ttf-parser skips a component without glyph data.
                    let Some(LocaGlyph::Glyph(child)) = self.loca.get(component.glyph, &self.glyf)
                    else {
                        continue;
                    };
                    let transform =
                        Transform::combine(builder.transform, component_transform(&component));
                    let bounds = {
                        let mut child_builder =
                            OutlineBuilder::new(transform, builder.bounds, &mut *builder.path);
                        self.outline_into(&child, depth + 1, &mut child_builder)?;
                        child_builder.bounds
                    };
                    builder.bounds = bounds;
                }
            }
        }
        Some(())
    }
}

/// ttf-parser's ascender/descender: the typographic values when OS/2 asks
/// for them, otherwise `hhea`, falling back to OS/2 where `hhea` is zero.
fn vertical_metrics(hhea: &Hhea, os2: Option<&Os2>) -> (i16, i16) {
    if let Some(os2) = os2 {
        if os2.version() >= 4
            && os2
                .fs_selection()
                .contains(SelectionFlags::USE_TYPO_METRICS)
        {
            return (os2.s_typo_ascender(), os2.s_typo_descender());
        }
    }
    let mut ascender = hhea.ascender().to_i16();
    let mut descender = hhea.descender().to_i16();
    if let Some(os2) = os2 {
        if ascender == 0 {
            ascender = os2.s_typo_ascender();
            if ascender == 0 {
                ascender = os2.us_win_ascent() as i16;
            }
        }
        if descender == 0 {
            descender = os2.s_typo_descender();
            if descender == 0 {
                descender = -(os2.us_win_descent() as i16);
            }
        }
    }
    (ascender, descender)
}

/// ttf-parser's notion of a Unicode subtable.
fn is_unicode_subtable(platform: PlatformId, encoding: u16, subtable: &CmapSubtable) -> bool {
    match platform {
        PlatformId::Unicode => true,
        PlatformId::Windows if encoding == 1 => true,
        PlatformId::Windows => {
            encoding == 10
                && matches!(
                    subtable,
                    CmapSubtable::Format12(_) | CmapSubtable::Format13(_)
                )
        }
        _ => false,
    }
}

/// A component's placement. ttf-parser applies the offset only for
/// `ARGS_ARE_XY_VALUES` (point anchors place nothing) and ignores the
/// rounding and scaled-offset flags.
fn component_transform(component: &Component) -> Transform {
    let mut transform = Transform::IDENTITY;
    if component
        .flags
        .contains(CompositeGlyphFlags::ARGS_ARE_XY_VALUES)
    {
        if let Anchor::Offset { x, y } = component.anchor {
            transform.e = f32::from(x);
            transform.f = f32::from(y);
        }
    }
    let matrix = component.transform;
    transform.a = matrix.xx.to_f32();
    transform.b = matrix.yx.to_f32();
    transform.c = matrix.xy.to_f32();
    transform.d = matrix.yy.to_f32();
    transform
}

enum PathSegment {
    MoveTo((f32, f32)),
    LineTo((f32, f32)),
    QuadTo((f32, f32), (f32, f32)),
    Close,
}

#[derive(Clone, Copy)]
struct Transform {
    a: f32,
    b: f32,
    c: f32,
    d: f32,
    e: f32,
    f: f32,
}

impl Transform {
    const IDENTITY: Self = Self {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    fn combine(ts1: Self, ts2: Self) -> Self {
        Self {
            a: ts1.a * ts2.a + ts1.c * ts2.b,
            b: ts1.b * ts2.a + ts1.d * ts2.b,
            c: ts1.a * ts2.c + ts1.c * ts2.d,
            d: ts1.b * ts2.c + ts1.d * ts2.d,
            e: ts1.a * ts2.e + ts1.c * ts2.f + ts1.e,
            f: ts1.b * ts2.e + ts1.d * ts2.f + ts1.f,
        }
    }

    fn is_identity(&self) -> bool {
        self.a == 1.0
            && self.b == 0.0
            && self.c == 0.0
            && self.d == 1.0
            && self.e == 0.0
            && self.f == 0.0
    }

    fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        (
            self.a * x + self.c * y + self.e,
            self.b * x + self.d * y + self.f,
        )
    }
}

#[derive(Clone, Copy)]
struct BoundsTracker {
    x_min: f32,
    y_min: f32,
    x_max: f32,
    y_max: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct GlyphBounds {
    x_min: i16,
    y_min: i16,
    x_max: i16,
    y_max: i16,
}

impl BoundsTracker {
    fn new() -> Self {
        Self {
            x_min: f32::MAX,
            y_min: f32::MAX,
            x_max: f32::MIN,
            y_max: f32::MIN,
        }
    }

    fn extend(&mut self, (x, y): (f32, f32)) {
        self.x_min = self.x_min.min(x);
        self.y_min = self.y_min.min(y);
        self.x_max = self.x_max.max(x);
        self.y_max = self.y_max.max(y);
    }

    fn to_glyph_bounds(self) -> Option<GlyphBounds> {
        if self.x_min == f32::MAX
            && self.y_min == f32::MAX
            && self.x_max == f32::MIN
            && self.y_max == f32::MIN
        {
            return None;
        }
        Some(GlyphBounds {
            x_min: truncate_to_i16(self.x_min)?,
            y_min: truncate_to_i16(self.y_min)?,
            x_max: truncate_to_i16(self.x_max)?,
            y_max: truncate_to_i16(self.y_max)?,
        })
    }
}

/// ttf-parser's `i16::try_num_from(f32)`: truncate through `i32`.
fn truncate_to_i16(value: f32) -> Option<i16> {
    const MIN: f32 = i32::MIN as f32;
    if value >= MIN && value < -MIN {
        i16::try_from(value as i32).ok()
    } else {
        None
    }
}

/// ttf-parser 0.15's `glyf` point walk: implied on-curve midpoints, the
/// contour start chosen from the first on-curve point, and the box of every
/// emitted point, control points included.
struct OutlineBuilder<'p> {
    path: &'p mut Vec<PathSegment>,
    transform: Transform,
    is_identity: bool,
    bounds: BoundsTracker,
    first_on_curve: Option<(f32, f32)>,
    first_off_curve: Option<(f32, f32)>,
    last_off_curve: Option<(f32, f32)>,
}

impl<'p> OutlineBuilder<'p> {
    fn new(transform: Transform, bounds: BoundsTracker, path: &'p mut Vec<PathSegment>) -> Self {
        Self {
            path,
            transform,
            is_identity: transform.is_identity(),
            bounds,
            first_on_curve: None,
            first_off_curve: None,
            last_off_curve: None,
        }
    }

    fn transformed(&self, (x, y): (f32, f32)) -> (f32, f32) {
        if self.is_identity {
            (x, y)
        } else {
            self.transform.apply(x, y)
        }
    }

    fn move_to(&mut self, p: (f32, f32)) {
        let p = self.transformed(p);
        self.bounds.extend(p);
        self.path.push(PathSegment::MoveTo(p));
    }

    fn line_to(&mut self, p: (f32, f32)) {
        let p = self.transformed(p);
        self.bounds.extend(p);
        self.path.push(PathSegment::LineTo(p));
    }

    fn quad_to(&mut self, control: (f32, f32), p: (f32, f32)) {
        let control = self.transformed(control);
        let p = self.transformed(p);
        self.bounds.extend(control);
        self.bounds.extend(p);
        self.path.push(PathSegment::QuadTo(control, p));
    }

    fn push_point(&mut self, x: f32, y: f32, on_curve: bool, last_point: bool) {
        let p = (x, y);
        if self.first_on_curve.is_none() {
            if on_curve {
                self.first_on_curve = Some(p);
                self.move_to(p);
            } else if let Some(off_curve) = self.first_off_curve {
                let mid = lerp_half(off_curve, p);
                self.first_on_curve = Some(mid);
                self.last_off_curve = Some(p);
                self.move_to(mid);
            } else {
                self.first_off_curve = Some(p);
            }
        } else {
            match (self.last_off_curve, on_curve) {
                (Some(off_curve), true) => {
                    self.last_off_curve = None;
                    self.quad_to(off_curve, p);
                }
                (Some(off_curve), false) => {
                    self.last_off_curve = Some(p);
                    self.quad_to(off_curve, lerp_half(off_curve, p));
                }
                (None, true) => self.line_to(p),
                (None, false) => self.last_off_curve = Some(p),
            }
        }
        if last_point {
            self.finish_contour();
        }
    }

    fn finish_contour(&mut self) {
        if let (Some(first_off), Some(last_off)) = (self.first_off_curve, self.last_off_curve) {
            self.last_off_curve = None;
            self.quad_to(last_off, lerp_half(last_off, first_off));
        }
        if let (Some(p), Some(first_off)) = (self.first_on_curve, self.first_off_curve) {
            self.quad_to(first_off, p);
        } else if let (Some(p), Some(last_off)) = (self.first_on_curve, self.last_off_curve) {
            self.quad_to(last_off, p);
        } else if let Some(p) = self.first_on_curve {
            self.line_to(p);
        }
        self.first_on_curve = None;
        self.first_off_curve = None;
        self.last_off_curve = None;
        self.path.push(PathSegment::Close);
    }
}

/// ttf-parser's `Point::lerp(other, 0.5)`, in its operation order.
fn lerp_half(a: (f32, f32), b: (f32, f32)) -> (f32, f32) {
    (a.0 + 0.5 * (b.0 - a.0), a.1 + 0.5 * (b.1 - a.1))
}

/// ttf-parser's endpoint flattening: `next()` is true on the last point of
/// each contour, with the same handling of malformed endpoint lists.
struct ContourEnds<'a> {
    end_points: &'a [BigEndian<u16>],
    index: u16,
    left: u16,
}

impl<'a> ContourEnds<'a> {
    fn new(end_points: &'a [BigEndian<u16>]) -> Option<Self> {
        Some(Self {
            end_points,
            index: 1,
            left: end_points.first()?.get(),
        })
    }

    fn next(&mut self) -> bool {
        if self.left == 0 {
            if let Some(end) = self.end_points.get(usize::from(self.index)) {
                let prev = self
                    .end_points
                    .get(usize::from(self.index - 1))
                    .map(|end| end.get())
                    .unwrap_or(0);
                self.left = end.get().checked_sub(prev).unwrap_or(0);
                self.left = self.left.checked_sub(1).unwrap_or(0);
            }
            if let Some(next) = self.index.checked_add(1) {
                self.index = next;
            }
            true
        } else {
            self.left -= 1;
            false
        }
    }
}

/// rusttype's `OutlineRasterizer`: `close` draws back to the last `move_to`.
struct RasterPen {
    rasterizer: Rasterizer,
    last: Point,
    last_move: Option<Point>,
}

impl RasterPen {
    fn new(width: usize, height: usize) -> Self {
        Self {
            rasterizer: Rasterizer::new(width, height),
            last: Point { x: 0.0, y: 0.0 },
            last_move: None,
        }
    }

    fn move_to(&mut self, p: Point) {
        self.last = p;
        self.last_move = Some(p);
    }

    fn line_to(&mut self, p: Point) {
        self.rasterizer.draw_line(self.last, p);
        self.last = p;
    }

    fn quad_to(&mut self, control: Point, p: Point) {
        self.rasterizer.draw_quad(self.last, control, p);
        self.last = p;
    }

    fn close(&mut self) {
        if let Some(start) = self.last_move {
            self.rasterizer.draw_line(self.last, start);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use read_fonts::types::Tag;

    const REGULAR: &[u8] = include_bytes!("../assets/fonts/NotoSerif-Regular.ttf");
    const BOLD: &[u8] = include_bytes!("../assets/fonts/NotoSerif-Bold.ttf");

    #[test]
    fn the_embedded_fonts_are_static_truetype_without_legacy_kerning() {
        // rusttype applied only the legacy `kern` table, and this module
        // reproduces it by applying none. A font change that brings a `kern`
        // table, CFF outlines or variations needs this module extended first.
        for data in [REGULAR, BOLD] {
            let font = FontRef::new(data).expect("embedded font parses");
            for tag in [b"kern", b"CFF ", b"CFF2", b"fvar", b"gvar"] {
                assert!(
                    font.table_data(Tag::new(tag)).is_none(),
                    "unexpected {:?} table",
                    Tag::new(tag)
                );
            }
            assert!(font.table_data(Tag::new(b"glyf")).is_some());
        }
    }

    #[test]
    fn greek_latin_and_euro_map_to_real_glyphs_and_a_space_draws_nothing() {
        let font = ReceiptFont::parse(REGULAR).expect("embedded font parses");
        for ch in ['A', 'z', '0', 'Ω', 'ά', 'ς', '€', '«'] {
            assert_ne!(font.glyph_id(ch), 0, "{ch} must have a glyph");
        }
        assert_eq!(font.glyph_id('\u{1FAF6}'), 0, "the emoji has no glyph");

        let mut plotted = 0;
        font.draw_glyph(font.glyph_id(' '), 24.0, 10.0, 30.0, |_, _, _| plotted += 1);
        assert_eq!(plotted, 0);
        assert!(font.advance_width(font.glyph_id(' '), 24.0) > 0.0);
    }

    #[test]
    fn a_glyph_covers_pixels_inside_its_advance_and_above_the_baseline() {
        let font = ReceiptFont::parse(BOLD).expect("embedded font parses");
        let glyph = font.glyph_id('Η');
        let (x, baseline) = (5.0, 40.0);
        let advance = font.advance_width(glyph, 32.0);
        let mut inked = 0;
        font.draw_glyph(glyph, 32.0, x, baseline, |px, py, coverage| {
            if coverage > 0.5 {
                inked += 1;
                assert!(px as f32 >= x - 1.0 && (px as f32) < x + advance + 1.0);
                assert!(py as f32 <= baseline && py as f32 >= baseline - font.ascent(32.0) - 1.0);
            }
        });
        assert!(
            inked > 50,
            "a 32 px bold capital inks a solid area, got {inked}"
        );
    }
}
