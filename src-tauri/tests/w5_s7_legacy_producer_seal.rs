//! Wave 5 Session 7 PR 1 — legacy-producer seal.
//!
//! Session 6 (2026-04-24, commits `0e6adc8b`..`00c2592e`) migrated every
//! production `INSERT INTO sync_queue` call site to `parity_sync_queue`
//! via `sync_queue::enqueue_payload_item`. This integration test prevents
//! regression: if any future non-test production code reintroduces a raw
//! `INSERT INTO sync_queue`, CI fails here with an actionable message.
//!
//! # Scope
//!
//! Walks `pos-tauri/src-tauri/src/**/*.rs`, skipping the `src/tests/`
//! subtree (declared test-only via `#[cfg(test)] mod tests;` in
//! `src/lib.rs`). For each file:
//!   1. Parse to `syn::File`.
//!   2. Walk every `syn::Item` / `ImplItem`.
//!   3. Skip any item whose `.attrs` contain `#[cfg(test)]` or `#[test]`.
//!   4. For retained items, extract the original source slice covered by
//!      the item's span and scan for the substring `INSERT INTO sync_queue`
//!      with a next-char word-boundary check (forward-proofs against a
//!      hypothetical `sync_queue_archive` style sibling table).
//!
//! # Why AST-aware instead of naive grep
//!
//! Test fixtures inside `#[cfg(test)] mod tests { ... }` blocks in
//! production files deliberately seed the legacy `sync_queue` table to
//! pin the dual-queue transitional-reader contract during the bake
//! window before migration v56 drops the table. A plain grep would flag
//! those and force an ever-growing allowlist; parsing with `syn` lets us
//! skip those subtrees cleanly with zero maintenance.
//!
//! # Known limitations
//!
//! - A doc comment (`/// ... INSERT INTO sync_queue ...`) sits inside the
//!   item's span and WOULD be caught. No current production doc comment
//!   contains this string; if someone adds one the seal will flag it and
//!   the author can either reword the comment or extend this walker.
//! - A `#[cfg(test)] mod foo;` declaration in a non-`src/tests/` location
//!   is not honoured — the child file would still be walked as
//!   production. Not a concern today because the only cross-file test
//!   module is `lib.rs` → `src/tests/`, and the directory filter handles
//!   that. If a second such declaration is added, extend the file
//!   collector to first parse root modules and build an exclusion set.

use proc_macro2::{LineColumn, Span};
use std::fs;
use std::path::{Path, PathBuf};
use syn::spanned::Spanned;
use syn::{Attribute, ImplItem, Item, Meta};

const SEAL_PATTERN: &str = "INSERT INTO sync_queue";

#[derive(Debug)]
struct Violation {
    file_rel: String,
    item_path: String,
    line: usize,
}

// ---------------------------------------------------------------------------
// Filesystem walk
// ---------------------------------------------------------------------------

/// Recursively collect every `.rs` file under `root`, skipping any
/// directory whose basename is `tests`. That directory holds the
/// parity-gate and harness subtree, which `src/lib.rs` gates wholesale
/// via `#[cfg(test)] mod tests;` — cross-file cfg(test) isn't visible to
/// a per-file AST walker so we skip it by path convention instead.
fn collect_rs_files(root: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if path.file_name().and_then(|n| n.to_str()) == Some("tests") {
                continue;
            }
            collect_rs_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("rs") {
            out.push(path);
        }
    }
}

// ---------------------------------------------------------------------------
// Test-attribute detection
// ---------------------------------------------------------------------------

/// `true` iff `attr` is `#[test]` or any `#[cfg(...)]` whose predicate
/// mentions the `test` identifier (covers `#[cfg(test)]`,
/// `#[cfg(any(test, feature = "x"))]`, `#[cfg(all(test, unix))]`, ...).
fn is_test_attr(attr: &Attribute) -> bool {
    match &attr.meta {
        Meta::Path(path) => path.is_ident("test"),
        Meta::List(list) if list.path.is_ident("cfg") => {
            token_contains_ident(&list.tokens.to_string(), "test")
        }
        _ => false,
    }
}

/// Whole-word search for `ident` within a tokenised string.
fn token_contains_ident(s: &str, ident: &str) -> bool {
    let bytes = s.as_bytes();
    let pat = ident.as_bytes();
    if pat.is_empty() || bytes.len() < pat.len() {
        return false;
    }
    let mut i = 0;
    while i + pat.len() <= bytes.len() {
        if &bytes[i..i + pat.len()] == pat {
            let prev_ok = i == 0 || !is_ident_continuation(bytes[i - 1]);
            let next_ok =
                i + pat.len() == bytes.len() || !is_ident_continuation(bytes[i + pat.len()]);
            if prev_ok && next_ok {
                return true;
            }
        }
        i += 1;
    }
    false
}

fn is_ident_continuation(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'_'
}

fn has_test_attr(attrs: &[Attribute]) -> bool {
    attrs.iter().any(is_test_attr)
}

// ---------------------------------------------------------------------------
// Item introspection
// ---------------------------------------------------------------------------

fn item_attrs(item: &Item) -> &[Attribute] {
    match item {
        Item::Const(i) => &i.attrs,
        Item::Enum(i) => &i.attrs,
        Item::ExternCrate(i) => &i.attrs,
        Item::Fn(i) => &i.attrs,
        Item::ForeignMod(i) => &i.attrs,
        Item::Impl(i) => &i.attrs,
        Item::Macro(i) => &i.attrs,
        Item::Mod(i) => &i.attrs,
        Item::Static(i) => &i.attrs,
        Item::Struct(i) => &i.attrs,
        Item::Trait(i) => &i.attrs,
        Item::TraitAlias(i) => &i.attrs,
        Item::Type(i) => &i.attrs,
        Item::Union(i) => &i.attrs,
        Item::Use(i) => &i.attrs,
        _ => &[],
    }
}

fn item_display_name(item: &Item) -> String {
    match item {
        Item::Const(i) => i.ident.to_string(),
        Item::Enum(i) => i.ident.to_string(),
        Item::ExternCrate(i) => i.ident.to_string(),
        Item::Fn(i) => i.sig.ident.to_string(),
        Item::ForeignMod(_) => "<extern>".to_string(),
        Item::Impl(i) => format!("impl {}", render_type_short(&i.self_ty)),
        Item::Macro(i) => i
            .ident
            .as_ref()
            .map(|id| id.to_string())
            .unwrap_or_else(|| "<macro>".to_string()),
        Item::Mod(i) => i.ident.to_string(),
        Item::Static(i) => i.ident.to_string(),
        Item::Struct(i) => i.ident.to_string(),
        Item::Trait(i) => i.ident.to_string(),
        Item::TraitAlias(i) => i.ident.to_string(),
        Item::Type(i) => i.ident.to_string(),
        Item::Union(i) => i.ident.to_string(),
        Item::Use(_) => "<use>".to_string(),
        _ => "<anon>".to_string(),
    }
}

fn render_type_short(ty: &syn::Type) -> String {
    match ty {
        syn::Type::Path(p) => p
            .path
            .segments
            .iter()
            .map(|s| s.ident.to_string())
            .collect::<Vec<_>>()
            .join("::"),
        _ => "?".to_string(),
    }
}

fn join_path(prefix: &str, name: &str) -> String {
    if prefix.is_empty() {
        name.to_string()
    } else {
        format!("{prefix}::{name}")
    }
}

// ---------------------------------------------------------------------------
// Per-file context (source + line offsets for span → byte conversion)
// ---------------------------------------------------------------------------

struct FileCtx<'a> {
    file_rel: String,
    source: &'a str,
    line_offsets: Vec<usize>,
}

impl<'a> FileCtx<'a> {
    fn new(file_rel: String, source: &'a str) -> Self {
        // `line_offsets[n]` = byte offset of the start of 1-indexed line n+1.
        let mut line_offsets = vec![0usize];
        for (i, ch) in source.char_indices() {
            if ch == '\n' {
                line_offsets.push(i + ch.len_utf8());
            }
        }
        Self {
            file_rel,
            source,
            line_offsets,
        }
    }

    fn byte_offset_of(&self, lc: LineColumn) -> usize {
        // proc_macro2 reports 1-indexed lines and 0-indexed character columns.
        let line_idx = lc.line.saturating_sub(1);
        let line_start = self
            .line_offsets
            .get(line_idx)
            .copied()
            .unwrap_or(self.source.len());
        let next_line_start = self
            .line_offsets
            .get(line_idx + 1)
            .copied()
            .unwrap_or(self.source.len());
        let line_slice = &self.source[line_start..next_line_start];
        let col_bytes: usize = line_slice
            .chars()
            .take(lc.column)
            .map(|c| c.len_utf8())
            .sum();
        (line_start + col_bytes).min(self.source.len())
    }

    fn line_for_byte(&self, byte: usize) -> usize {
        // Largest line index whose offset is <= byte, 1-indexed.
        match self.line_offsets.binary_search(&byte) {
            Ok(idx) => idx + 1,
            Err(idx) => idx.max(1),
        }
    }
}

// ---------------------------------------------------------------------------
// AST walk
// ---------------------------------------------------------------------------

fn walk_item(item: &Item, prefix: &str, ctx: &FileCtx, violations: &mut Vec<Violation>) {
    if has_test_attr(item_attrs(item)) {
        return;
    }
    let name = item_display_name(item);
    let here = join_path(prefix, &name);

    match item {
        // Inline module: recurse into nested items (declaration-only
        // `mod foo;` has `content == None` and falls through to the
        // span-scan, which catches nothing because the body lives in a
        // sibling file walked separately).
        Item::Mod(m) if m.content.is_some() => {
            if let Some((_, nested)) = &m.content {
                for n in nested {
                    walk_item(n, &here, ctx, violations);
                }
            }
        }
        Item::Impl(impl_block) => {
            for impl_item in &impl_block.items {
                walk_impl_item(impl_item, &here, ctx, violations);
            }
        }
        other => {
            scan_span(other.span(), &here, ctx, violations);
        }
    }
}

fn walk_impl_item(ii: &ImplItem, prefix: &str, ctx: &FileCtx, violations: &mut Vec<Violation>) {
    let attrs: &[Attribute] = match ii {
        ImplItem::Fn(f) => &f.attrs,
        ImplItem::Const(c) => &c.attrs,
        ImplItem::Type(t) => &t.attrs,
        ImplItem::Macro(m) => &m.attrs,
        _ => &[],
    };
    if has_test_attr(attrs) {
        return;
    }
    let name = match ii {
        ImplItem::Fn(f) => f.sig.ident.to_string(),
        ImplItem::Const(c) => c.ident.to_string(),
        ImplItem::Type(t) => t.ident.to_string(),
        _ => "<impl-item>".to_string(),
    };
    let here = join_path(prefix, &name);
    scan_span(ii.span(), &here, ctx, violations);
}

fn scan_span(span: Span, item_path: &str, ctx: &FileCtx, violations: &mut Vec<Violation>) {
    let start = ctx.byte_offset_of(span.start());
    let end = ctx.byte_offset_of(span.end()).max(start);
    if start >= ctx.source.len() {
        return;
    }
    let end = end.min(ctx.source.len());
    let slice = &ctx.source[start..end];
    if let Some(offset) = find_seal_match(slice) {
        let line = ctx.line_for_byte(start + offset);
        violations.push(Violation {
            file_rel: ctx.file_rel.clone(),
            item_path: item_path.to_string(),
            line,
        });
    }
}

fn find_seal_match(haystack: &str) -> Option<usize> {
    let bytes = haystack.as_bytes();
    let pat = SEAL_PATTERN.as_bytes();
    if bytes.len() < pat.len() {
        return None;
    }
    let mut i = 0;
    while i + pat.len() <= bytes.len() {
        if &bytes[i..i + pat.len()] == pat {
            let next_ok =
                i + pat.len() == bytes.len() || !is_ident_continuation(bytes[i + pat.len()]);
            if next_ok {
                return Some(i);
            }
        }
        i += 1;
    }
    None
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

fn crate_src_root() -> PathBuf {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR")
        .expect("CARGO_MANIFEST_DIR must be set when running tests");
    PathBuf::from(manifest_dir).join("src")
}

#[test]
fn no_legacy_sync_queue_producers_in_production_code() {
    let src_root = crate_src_root();
    assert!(
        src_root.is_dir(),
        "expected src root at {src_root:?} — working directory layout changed?"
    );

    let mut files = Vec::new();
    collect_rs_files(&src_root, &mut files);
    files.sort();
    assert!(
        !files.is_empty(),
        "no .rs files discovered under {src_root:?}"
    );

    let mut violations = Vec::new();
    for file_path in &files {
        let source = fs::read_to_string(file_path)
            .unwrap_or_else(|e| panic!("failed to read {file_path:?}: {e}"));
        let parsed = syn::parse_file(&source)
            .unwrap_or_else(|e| panic!("failed to parse {file_path:?}: {e}"));
        let rel = file_path
            .strip_prefix(&src_root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_else(|_| file_path.display().to_string());
        let ctx = FileCtx::new(rel, &source);
        for item in &parsed.items {
            walk_item(item, "", &ctx, &mut violations);
        }
    }

    if !violations.is_empty() {
        let mut msg = String::from(
            "\n\nWave 5 Session 7 seal violated: a raw `INSERT INTO sync_queue` \
             statement was found in non-test production code. The legacy \
             `sync_queue` table is drain-only pending migration v56; new \
             producers MUST call `sync_queue::enqueue_payload_item(...)` \
             (writes to `parity_sync_queue`). See \
             `project_wave5_session6_partial.md` for the migration recipe.\n\
             Offending sites:\n",
        );
        for v in &violations {
            msg.push_str(&format!(
                "  - src/{}:{}  in  {}\n",
                v.file_rel, v.line, v.item_path
            ));
        }
        panic!("{msg}");
    }
}
