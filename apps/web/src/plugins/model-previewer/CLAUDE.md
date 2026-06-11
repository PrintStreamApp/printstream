# model-previewer — the 3MF Project Editor (web)

This plugin is the **3MF Project Editor** half of the slicer area (the other half, the CLI
slicing pipeline, is the slice settings UI in `pages/LibraryView.tsx` + the api/slicer
services). Read `docs/slicer-architecture.md` before non-trivial work here.

- **Scope:** arrange/transform objects on plates, materials, per-object overrides,
  printability, plane cuts, support/seam/colour painting (`lib/supportPaint.ts` +
  `lib/trianglePaintTree.ts`: Bambu-style sub-triangle sphere/circle brushes, smart fill,
  and colour-only triangle + height-range tools writing `paint_supports`/`paint_seam`/
  `paint_color` codes on in-project parts), added part volumes (negative parts,
  modifiers, support blockers/enforcers — cube primitives staged as imports, baked as
  `<component>`s with `model_settings` subtypes via `SceneEdit.addedParts`), manual brim ears
  (click-placed, baked to `Metadata/brim_ear_points.txt`), per-plate layer-based
  filament changes (baked to `Metadata/custom_gcode_per_layer.xml`), a two-point measure
  tool (corner-snapping, viewport-only — no `SceneEdit` impact), and read-only preview
  (incl. sliced-gcode toolpaths with a BS-style stats panel: per-feature time breakdown from
  the move parse, normalized to the slicer's slice_info `prediction` / gcode-header total).
  The bed renders a true-millimetre grid (10mm/50mm lines + edge coordinate labels via
  `createPreviewPlateSurface`). It produces a `SceneEdit` (the locked contract) and never
  invokes the slicer itself.
- **The Cut tool, Split-to-objects, and Add-primitive create geometry without new API
  surface:** `lib/meshCut.ts` plane-cuts the selected object's world-space mesh (capping
  cross-sections) or splits it into connected shells, `lib/primitives.ts` generates
  cube/cylinder/sphere/cone soups; each piece is serialized as binary STL and staged
  through the existing foreign-import endpoint — they become ordinary import-backed
  instances in the `SceneEdit`.
- **Auto-arrange** packs the active plate centre-out by TRUE rasterized footprints
  (`lib/arrange.ts`, same 2mm grid as the placement warnings), honouring nozzle-reach
  rects, unprintable zones, and the prime tower. **Auto-orient** rests the selected
  object on its largest convex-hull face. **Brim ears** always project to the bed and
  face up (Bambu rule) — markers re-bake world-flat matrices every frame.
- **Source of truth for the scene is `lib/editorModel.ts`.** `EditorInstance` is the
  editable unit; mutations (seed/duplicate/move/reindex) and `buildSceneEdit` live there.
  Keep scene-model logic in this module, not sprinkled in the ~4k-line `EditorView.tsx`.
- **Printability is editor-owned and per-instance** (`EditorInstance.printable`), carried
  through moves/duplicates and emitted in `buildSceneEdit`. Do **not** re-derive the
  editor's print/skip state from the slice dialog's per-plate selection
  (`sliceConfig.printSelection`/`plateObjects`) — that is keyed off the static baked index
  and does not follow editor edits. The slice dialog's selection is for the simple
  (non-editor) slice path only.
- **Slicing config is borrowed, not owned.** `sliceConfig` (`SliceSettingsController`) is
  passed in from `LibraryView`; use it for materials/process overrides, but the editor must
  not grow its own slicer-target/profile state.
- Heavy deps (Three.js, parsers) stay code-split inside this plugin (see
  `apps/web/CLAUDE.md` and `.claude/guides/plugins.md`).
</content>
