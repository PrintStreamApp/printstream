# Slicer architecture

The "slicer" area is **two features that share one data model**, and keeping them
separated is what stops this fast-growing area from turning into a patchwork:

1. **3MF Project Editor** — a BambuStudio-compatible editor for *arranging* a project:
   placing/transforming objects on plates, assigning materials, per-object process
   overrides, and printability. It mutates an in-memory scene and emits a `SceneEdit`.
2. **CLI Slicing Pipeline** — takes a (baked) 3MF and *slices* it with the BambuStudio
   CLI: job queue, profile resolution, the standalone slicer service, and output
   packaging.

They meet at the **shared 3MF model**: the `SceneEdit` contract plus the 3MF
reader/writer. The editor produces a `SceneEdit`; the pipeline bakes it into a 3MF and
slices it. Neither feature should reach into the other's internals — they communicate
through the `SceneEdit` contract and the baked 3MF on disk.

```
  EDITOR  ──emits──▶  SceneEdit (shared contract)  ──baked by──▶  3MF on disk  ──▶  SLICING PIPELINE
 (arrange)                                          buildEditedThreeMf            (BambuStudio CLI)
```

## Where the code lives

| Concern | Layer | Key modules |
| --- | --- | --- |
| **Editor** | web | `apps/web/src/plugins/model-studio/` — `EditorView.tsx` (3D editor), `lib/editorModel.ts` (the editable scene model + `buildSceneEdit`), `lib/threeMfScene.ts` (scene→Three.js), `lib/editorImports.ts`, `lib/meshCut.ts` (Cut tool: plane cut + capped halves staged as imports) |
| **Editor** | api | `routes/editor.ts` (save + staged imports), `lib/import-store.ts`, `lib/mesh-import.ts`; `lib/three-mf-scene-builder.ts` (`buildEditedThreeMf`) |
| **Slicing** | web | the slice UI in `pages/LibraryView.tsx` (`SliceSettingsController`, `SliceSettingsPanel`), `components/ProcessSettingsDialog.tsx`, `components/PerObjectSettingsDialog.tsx` |
| **Slicing** | api | `routes/slicing.ts`, `lib/slicing-jobs.ts`, `lib/slicer-client.ts`, `lib/slicing-profiles.ts` |
| **Slicing** | slicer | `apps/slicer/**` — the standalone BambuStudio CLI service (profile resolution, machine-switch, output metadata) |
| **Shared 3MF model** | shared | `packages/shared/src/slicing.ts` (`SceneEdit`, slicing job contracts), the scene/index schemas in `printer.ts` |
| **Shared 3MF model** | api/bridge/shared | the `apps/api/src/lib/three-mf-*.ts` modules (read + write, re-exported via the `three-mf.ts` barrel); the pure **index** parse lives in `@printstream/shared/three-mf` and is shared by `three-mf-reader.ts` and the bridge's `apps/bridge/src/library-3mf.ts` (no hand-kept mirror) |
| **Printer retarget** | shared/api | "Save as a different printer" — rewrites a project's machine + process settings (no slicing). `packages/shared/src/machine-retarget.ts`, `apps/api/src/lib/save-retarget.ts`. See `docs/project-printer-retarget.md` |

## The `SceneEdit` contract (the seam)

`SceneEdit` (`packages/shared/src/slicing.ts`) is the **locked** boundary between the two
features. The editor's `buildSceneEdit(state)` produces it; `buildEditedThreeMf` (api)
consumes it to rewrite the 3MF's `<build>` section and `model_settings.config`. Per
instance it carries the geometry reference (`objectId` or staged `importId`), `plateIndex`,
decomposed transform (or a full `matrix`), optional `filamentId`, and `printable`.

Per-part extensions ride alongside the instances: `partFilaments` (material
reassignment), `objectNames` (renames), and the three paint channels `supportPaint` /
`seamPaint` / `colorPaint` — the support, seam, and colour brushes' complete per-part
triangle paint maps (`paint_supports` / `paint_seam` codes: `'4'` enforcer, `'8'`
blocker; `paint_color` whole-triangle states map to 1-based filament ids, '4'/'8'/'0C'/
'1C'...; longer split codes from the source file are preserved verbatim). The api rewrites a painted
part's `<triangle>` attributes inside the mesh's model entry (root or
`3D/Objects/*.model`); parts never painted in the session are copied byte-for-byte.
The editor parses existing paint from the scene-entry XML (`lib/threeMfScene.ts` →
`geometry.userData.supportPaint`/`seamPaint`), renders each channel as a
vertex-coloured overlay (blue/red supports, green/orange seam), and authors paint with
Bambu-faithful tools (`lib/supportPaint.ts` + `lib/trianglePaintTree.ts`): sphere and
circle (view-ray cylinder) brushes that grow from the hit triangle over shared edges
and split partially covered triangles to `min(radius/5, 0.2mm)` edges, smart fill
(flood across edges while neighbouring normals stay within an angle limit), and on the
colour channel single-triangle painting, same-state bucket fill, and a height-range
band (split crisply at the world-z planes). Brush options mirror Bambu's: edge
detection (colour brushes stop at sharp edges) and on-overhangs-only for support
painting (world-normal gate that also blocks propagation). `brimEars` carries per-object manual brim
ears (object-local points + radius), written wholesale to Bambu's
`Metadata/brim_ear_points.txt` (objects referenced by 1-based root-resource ordinal);
`readSceneManifest` parses the sidecar back onto scene instances so reopened
projects keep their ears. `filamentChanges` carries per-plate layer-based filament
changes (ToolChange entries in `Metadata/custom_gcode_per_layer.xml`); the writer
merges listed plates' tool changes while preserving pause/custom entries and
untouched plates, and the scene response seeds the editor's per-plate list.
`addedParts` carries new volumes added INSIDE objects (Bambu's negative parts,
modifiers, support blockers/enforcers): each references a staged import's mesh plus
an object-local 12-number matrix; the writer injects the mesh as a new object
resource, references it as a `<component>` of the parent root object, and adds a
`<part subtype="...">` to the parent's `model_settings.config` entry. Modifier
parts may carry per-volume process overrides (`settings`, edited via the same
restricted-catalog ProcessSettingsDialog as per-object overrides), written as
`<metadata key value/>` entries inside the part block — exactly how BambuStudio
persists ModelVolume config, so the slicer applies them inside the volume. Parents
carrying an inline mesh are first wrapped (mesh moves to its own object behind an
identity component) so 3MF's mesh-XOR-components rule holds. Painting/ears/parts
are limited to in-project parts; imports/cut halves are not supported yet.

`meshReplacements` carries BambuStudio "Replace with…" swaps: each `{objectId, importId}`
records that an in-project object's mesh was replaced by a staged import. The replaced
object's placed instances reference the import (so the original object drops out of the
bake via the same unreferenced-object sweep as Cut/Split), but its **identity is retained**
for the slicer. `buildEditedThreeMf` returns `replacedObjectIds` (each original objectId →
the baked object_id its import landed on); the slicer uses that to re-key the object's
**per-object process overrides** onto the replacement before slicing. Those overrides are
NOT part of `SceneEdit` — they ride the slice request's `objectProcessOverrides` (keyed by
Bambu object_id). The editor-arranged path now applies them via `createObjectCustomizedThreeMf`
after the bake (previously skipped whenever a `sceneEdit` was present); the original object's
name also travels onto the replacement via `objectNames` (importId-keyed).

**Imported-object 3MF structure (Production Extension).** When the base project uses the 3MF
Production Extension (`requiredextensions="p"` — what BambuStudio writes), the bake emits every
injected `<object>`/`<component>`/build `<item>` with a `p:UUID`, and a multi-solid import's solids
are written to a **separate `3D/Objects/printstream_object_<id>.model` sub-model** referenced by
`p:path` from a small root `<components>` assembly object (declared in `3D/_rels/3dmodel.model.rels`).
This mirrors BambuStudio's own split-model layout, and both parts are load-bearing: BambuStudio's
**GUI** rejects a saved import that is inline-in-root or UUID-less with "The file does not contain any
geometry data" (the CLI tolerates it, which is why it only shows up on GUI open), and per-object part
files let the editor fetch/parse only the objects a plate shows instead of the whole root model.
`readSceneManifest` resolves `p:path` sub-models, so save→reopen re-hydrates the assembly's solids as
its parts. Projects WITHOUT the production extension (fresh/core 3MFs) keep the simpler inline-mesh
form (no UUIDs needed — the GUI accepts inline geometry in a non-production document).

The process-settings catalog behind those dialogs
(`packages/shared/src/generated/process-settings.generated.ts`) is generated —
not hand-edited — by `scripts/dev/generate-process-settings.mjs`, which
transcribes the page/group layout and option metadata from a BambuStudio
source checkout (`--src <bambustudio-src>`). Re-run it when bumping the
BambuStudio pin.

## Printability ("Printable" toggle)

Mirrors BambuStudio: a non-printable object is **greyed out** and **excluded from the
slice**, but **kept in the saved 3MF** so it can be re-enabled. It is an **editor-owned,
per-instance** property — *not* the slice dialog's per-plate object selection (which is
derived from the static baked index and does not follow editor moves).

Forward path:
- `EditorInstance.printable` (`lib/editorModel.ts`), default `true`, carried verbatim
  through moves/duplicates/undo. Drives the viewport dim (`setObjectPrintedStyle`) and the
  Objects-list toggle.
- `buildSceneEdit` emits `printable: false` only for skipped instances.
- `buildEditedThreeMf` (`three-mf-scene-builder.ts`) writes `printable="0"` on the build `<item>` —
  BambuStudio's native attribute, which the CLI honours (excludes from slice) and which is
  retained in the saved 3MF.

Round-trip (reopen): `readSceneManifest` parses `<item printable="0">` back onto the scene
instance (`parseRootBuildItemPrintable`), so the editor seeds `EditorInstance.printable`
and a reopened project keeps its greyed objects. This read path is **API-only** — the bridge
does not parse build items (the shared parser only builds the index); the scene is always
assembled by `three-mf-reader.ts` from a locally-resolved file.

## Invariants

- **Shared 3MF index parser.** The parsed *index* shape is produced by one shared module,
  `@printstream/shared/three-mf`, consumed by both `apps/api/src/lib/three-mf-reader.ts` and
  `apps/bridge/src/library-3mf.ts`. Changing the index shape means editing that parser once,
  updating the shared schema, and bumping `THREE_MF_INDEX_PARSER_VERSION` — see
  the API development notes and the bridge development notes. (The full scene parse —
  `three-mf-reader.ts`'s `readSceneManifest` — and all 3MF *writing*
  (`three-mf-scene-builder.ts`, `three-mf-output.ts`) live only in the api modules.)
- **Nozzle-id mapping** in the slicer's `output-metadata.ts` must stay byte-for-byte —
  see the slicer development notes.
- The editor reflects new state through scene re-render, not optimistic UI guesses.

## Known god files / target decomposition (roadmap)

These predate the two-feature framing; split them incrementally toward it (each split is its
own verified change — do not big-bang):

- **Done:** `apps/api/src/lib/three-mf.ts` (~3.7k lines) split into `three-mf-internal.ts`
  (shared ZIP I/O + abort/escape helpers + `rewriteModelSettingsThreeMf`), `three-mf-reader.ts`
  (read/index/scene parse — the index half delegates to the shared `@printstream/shared/three-mf`
  parser), `three-mf-scene-builder.ts` (editor:
  `buildEditedThreeMf`/`writeArrangedThreeMf`), and `three-mf-output.ts` (slicing: single-plate/
  thumbnail output + sliced-gcode object previews). Dependencies flow one way
  (output/scene-builder → reader → internal); `three-mf.ts` is now a re-export barrel for the
  stable public API. Consumers still import from `three-mf.ts`; migrating them to the focused
  modules is a later increment.
- `apps/web/src/pages/LibraryView.tsx` (~8k lines) → extract `SliceSettingsController` +
  `SliceSettingsPanel` into their own slicing module, leaving LibraryView as the file
  browser.
- `apps/web/src/plugins/model-studio/EditorView.tsx` (~4k lines) → extract gizmo modes,
  undo/redo history, and save flows into focused modules; keep scene-model logic in
  `lib/editorModel.ts`.
</content>
