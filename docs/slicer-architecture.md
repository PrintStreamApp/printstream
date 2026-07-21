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
| **Editor** | api | `routes/editor.ts` (save, staged imports, and the no-persist `POST /export-3mf` download bake), `lib/import-store.ts`, `lib/mesh-import.ts` (STL parse + STEP tessellation), `lib/three-mf-mesh-extract.ts` (3MF geometry import: first non-empty plate → one part per placed part, helper volumes CARRIED with their subtype but excluded from the merged mesh + re-centring, group re-centred on origin); `lib/three-mf-scene-builder.ts` (`buildEditedThreeMf`) |
| **Slicing** | web | the slice UI in `components/library/` — `SliceFileModal.tsx`, `SliceSettingsPanel.tsx` (`SliceSettingsController`; materials render as compact one-line swatch rows), `MaterialEditDialog.tsx` (the expanded per-material type/preset/color inputs, reached from a swatch row via `MaterialSwatchButton.tsx`, whose menu also assigns the printer's loaded materials directly), `FilamentSettingsDialog.tsx` (material settings, shares `components/settings/SettingValueField.tsx`) — plus `components/ProcessSettingsDialog.tsx` and `components/PerObjectSettingsDialog.tsx` |
| **Slicing** | api | `routes/slicing.ts`, `lib/slicing-jobs.ts`, `lib/slicer-client.ts`, `lib/slicing-profiles.ts` |
| **Slicing** | slicer | `apps/slicer/**` — the standalone BambuStudio CLI service (profile resolution, machine-switch, output metadata) |
| **Shared 3MF model** | shared | `packages/shared/src/slicing.ts` (`SceneEdit`, slicing job contracts), the scene/index schemas in `printer.ts` |
| **Shared 3MF model** | api/bridge/shared | the `apps/api/src/lib/three-mf-*.ts` modules (read + write, re-exported via the `three-mf.ts` barrel); the pure **index** parse lives in `@printstream/shared/three-mf` and is shared by `three-mf-reader.ts` and the bridge's `apps/bridge/src/library-3mf.ts` (no hand-kept mirror) |
| **Printer retarget** | shared/api | "Save as a different printer" — rewrites a project's machine + process settings (no slicing). `packages/shared/src/machine-retarget.ts`, `apps/api/src/lib/save-retarget.ts`. See `docs/project-printer-retarget.md` |
| **Calibration** | api/web plugin | Builds disposable calibration prints (PA towers, flow plates) and runs them through the slicing pipeline + dispatcher. `apps/api/src/plugins/calibration/**`, `apps/web/src/plugins/calibration/**`. See "Calibration (plugin surface)" below |

## The no-save-first rule

Every editor edit must work on a model with **no baked 3MF identity yet** — a staged import, a
Cut/Split/Assemble output, or an independent copy. That is a hard contract, not a nicety: the
editor is the only place a project is arranged, and "save, reopen, then you can do it" makes an
edit that the UI already offered silently unavailable or silently lost.

Concretely, a per-object or per-part seam must address the model by its **editor-side identity** and
resolve it to a real `object_id` server-side at bake time. Three established patterns cover every
case — use one, do not invent a fourth:

| Editor-side identity | Carried as | Resolved by |
| --- | --- | --- |
| Staged import | `importId` (+ 0-based solid index for its parts) | `importIdToObjectId` while injecting the import |
| Independent copy | negative placeholder `objectId` | `objectClones` pre-pass (`three-mf-object-clone.ts`) |
| Data riding the save/slice REQUEST, not the edit | the same editor-side id | `replacedObjectIds` / `clonedObjectIds` + `rekeyReplacedObjectOverrides` |

The failure has a quiet form worth watching for: a collector in `buildSceneEdit` whose
`placedObjectIds` set is built only from `source.kind === 'object'` accepts the user's edit in the
UI and then drops it at bake time, with no error anywhere.

## Saves are delta-against-the-base — and what that constrains

A `SceneEdit` is deliberately **not** a whole-file description. A 3MF carries far more than the
editor models (the full process/machine config, slice_info, sub-model layout, vendor metadata), and
the base file is the carrier for all of it — so the edit describes only the domains the editor
owns, and everything else is copied through.

That makes two rules load-bearing:

1. **Within a domain the editor owns, the payload is COMPLETE STATE, never a diff.** A part's paint
   map is the whole desired map for that part; `brimEars` is the whole desired ear set for the
   object; `filaments` is the whole desired filament list. This is why a cleared value can be
   expressed at all (an empty map/list means "remove", which a diff could not say).
2. **An emit may be SKIPPED only when the base file already carries that value.** Skipping is how an
   untouched project avoids a pointless rewrite — but it is only safe because the base still holds
   the answer. The moment the editor synthesises state the base does NOT have, skipping is silent
   data loss.

Rule 2 is the one that has actually bitten, and its subtlety is worth spelling out because the
obvious reading of it is wrong. `desiredFilaments` was gated on "changed versus the base". A new
project's scaffold DOES seed one filament (`POST /editor/new-project`), so "the base has none" is
false — yet an editor-born save passes **`ignoreBaseContent`**, and the route then bakes with
`baseSource = null`. The base file is a save TARGET only; none of its bytes are carried. So nothing
could differ from the scaffold, the list was never emitted, the base contributed nothing, and a new
project saved with its default material reopened with **no materials at all** — which in turn
stranded colour paint, whose codes are filament ids, rendering it in the fallback palette.

The correct question for a gate is therefore not "did the user change it?" and not even "does the
base file contain it?", but: **"will this save carry the base's content at all?"** Since that is not
knowable where most of these values are computed, the safe rule is simply to always emit complete
state for an editor-owned domain and let the writer no-op when nothing differs.

## The `SceneEdit` contract (the seam)

`SceneEdit` (`packages/shared/src/slicing.ts`) is the **locked** boundary between the two
features. The editor's `buildSceneEdit(state)` produces it; `buildEditedThreeMf` (api)
consumes it to rewrite the 3MF's `<build>` section and `model_settings.config`. Per
instance it carries the geometry reference (`objectId` or staged `importId`), `plateIndex`,
decomposed transform (or a full `matrix`), optional `filamentId`, and `printable`.

Per-part extensions ride alongside the instances: `partFilaments` (material
reassignment — only for parts that HAVE a material: normal parts and modifiers, whose
region can change the printed filament. A support blocker/enforcer or negative volume
never carries one, is never given the object's, and never gets an `extruder` written back;
this mirrors BambuStudio, which draws the extruder swatch for `MODEL_PART` and
`PARAMETER_MODIFIER` only. `threeMfPartSubtypeCarriesFilament` in `@printstream/shared` is
the single predicate for it), `objectNames` (renames), and the three paint channels `supportPaint` /
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
projects keep their ears. `filamentChanges` and `pauses` carry per-plate layer-based
filament changes and layer pauses (ToolChange / PausePrint entries in
`Metadata/custom_gcode_per_layer.xml`, both keyed by the target layer's `top_z` in mm
— the slicer re-snaps to the nearest layer at slice time, BambuStudio semantics); the
writer replaces only the listed plates' entries of the edited type while preserving
the other entry types and untouched plates, and the scene response seeds the editor's
per-plate lists. The prepare-print dialog edits the same entries WITHOUT a
`SceneEdit`: the shared 3MF index surfaces each plate's baked changes/pauses, the
dialog's edits ride `createSlicingJob`'s top-level `filamentChanges`/`pauses`
(same replace-per-plate schemas; ignored when a `sceneEdit` is present, which carries
its own), and the API merges them into the slice input via the object-customization
rewrite — a slice-only edit that never touches the library file.
`addedParts` carries new volumes added INSIDE models (BambuStudio's "Add part" plus
the helper volumes — negative parts, modifiers, support blockers/enforcers): each
references its own mesh as `meshImportId` (a staged import, whether a generated
primitive or a loaded model file) plus an object-local 12-number matrix; the writer
injects the mesh as a new object resource, references it as a `<component>` of the
host root object, and adds a `<part subtype="...">` to the host's
`model_settings.config` entry. **The host is `objectId` XOR `importId`** — an
in-project object, or a staged import for a part added to a model the user has not
saved yet, resolved through the same `importIdToObjectId` map that places the import
itself (so `applyAddedParts` must run after the imports are injected). A part whose
subtype carries a filament (`threeMfPartSubtypeCarriesFilament`: normal parts and
modifiers) also ships `filamentId`, written as the part's `extruder` metadata —
without it an added printed part would silently print in filament 1. Modifier
parts may carry per-volume process overrides (`settings`, edited via the same
restricted-catalog ProcessSettingsDialog as per-object overrides), written as
`<metadata key value/>` entries inside the part block — exactly how BambuStudio
persists ModelVolume config, so the slicer applies them inside the volume. Hosts
carrying an inline mesh are first wrapped (mesh moves to its own object behind an
identity component) so 3MF's mesh-XOR-components rule holds — the normal path for a
freshly baked import host. Painting and brim ears are still limited to in-project
parts; imports/cut halves are not supported for those yet.
A 3MF **import** carries its volume types in: `three-mf-mesh-extract.ts` keeps helper volumes as
parts with their raw `subtype` (BambuStudio's "Import Object" is `LoadStrategy::LoadModel`, which
loads a 3MF's ModelVolumes whole and applies each type unconditionally — only the CONFIG is
dropped), the staged import records it per solid, and the bake writes it back unless
`importPartTypes` overrides. Helper volumes are kept OUT of the import's merged mesh and out of
its re-centring, since those drive bounds, the thumbnail, and where the import rests. A helper
volume never receives an `extruder`, so it cannot inherit the object's material.
`objectClones` carries INDEPENDENT object copies — BambuStudio's Ctrl+C/V
(`Model::add_object(*src_object)`), as opposed to placing another instance against the same
`objectId`, which is its toolbar "+" (`increase_instances`) and stays fully linked. A copy is
addressed throughout the edit by a NEGATIVE placeholder object id; a pre-pass
(`three-mf-object-clone.ts`) deep-copies the source object's XML, its `model_settings` entry, and
its `/3D/Objects` mesh sub-model into fresh ids, then rewrites the whole edit so every placeholder
and every SOURCE component id becomes the copy's real id. Running it first is what let every other
seam stay clone-agnostic. The mesh sub-model must be copied, not shared: paint and mesh repair are
applied per (ZIP entry, object id), so a shared mesh would make painting the copy repaint its source.
`importPartTransforms` is the import counterpart of `partTransforms`: a multi-solid import's solids
can be moved with the part gizmo before the project is ever saved, keyed by import + 0-based solid
index because an unsaved import has no baked 3MF part ids. It is applied as that solid's
`<component transform>` while the import bakes into one object; untouched solids stay at identity,
since an import's per-solid meshes already share assembly space.
`partTypeChanges` / `importPartTypes` carry BambuStudio's "Change type" (normal /
negative / modifier / support blocker / enforcer) on existing parts: the first keys by
objectId+componentObjectId (baked parts, applied by rewriting the `<part>`'s `subtype`
attribute), the second by importId+solid index (unsaved multi-solid imports, whose parts
are baked with the chosen subtype instead of `normal_part`). Retyped parts render as
translucent volumes and per-part process overrides apply inside them, exactly like
added modifier volumes.

`partTransforms` carries part-placement edits (moving / rotating / scaling a BAKED part
inside its object — e.g. repositioning a support blocker after a save): keyed by
objectId+componentObjectId with the part's new object-local 12-number matrix. The writer
rewrites the part's `<component transform>` — the placement BambuStudio and the CLI
slicer actually load into the volume (verified against the BambuStudio reader:
`model_settings`'s `matrix` metadata only feeds `volume->source.transform`) — and
mirrors the `matrix` metadata (row-major 4x4) when present so a later BambuStudio
re-save doesn't compound a stale source record. Placement is geometry-level, shared by
every placed instance of the object.

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

`repairedObjectIds` carries BambuStudio's per-object "fix model": each entry is an in-project
object the user right-clicked → **Repair mesh** in the editor. Unlike `meshReplacements`, this is
NOT a geometry swap — `buildEditedThreeMf` resolves each marked root object to the entries that
actually carry its meshes (a Bambu project keeps each object's mesh in its own
`3D/Objects/*.model`) and runs `three-mf-mesh-repair` **in place** on just those meshes: a
nearby-vertex weld (closing sub-tolerance cracks) plus degenerate/duplicate facet pruning — the
admesh pass BambuStudio applies to STL imports but skips for a 3MF's triangles. In place is the
whole point: it preserves the object's per-triangle paint and its part volumes, which rebuilding
the geometry would destroy. For the same reason the bake applies **paint before repair** (repair
carries each triangle's attributes through while welding/dropping, so painting first rides through
it; painting after would index triangles repair removed). Marking is the entire client-side edit —
repair is visually a no-op — and nothing repairs automatically: slicing never silently alters
geometry.

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

Each option carries BambuStudio's mode tier (`simple`/`advanced`/`develop`). The
editor always shows the advanced superset (simple + advanced) and hides the
`develop`-tier options unless **developer slicer settings** is on. That preference
follows the general-settings shape: a workspace-wide shared default persisted in
`GeneralSettings.slicerDeveloperMode` (via `/api/settings`) plus an optional
per-device localStorage override, both edited from the Slicing settings page
(`components/settings/SlicerDeveloperModeCard.tsx`). The editor reads the effective
value through `useEffectiveSlicerDeveloperMode` (`apps/web/src/lib/slicerDeveloperMode.ts`);
the tier gate is `isProcessOptionVisibleInMode` in
`packages/shared/src/process-settings.ts`. Revealed options still obey the usual
conditional visibility rules.

### Global process settings persist through the editor's save

Global (project-wide) process edits made in the editor persist into the saved 3MF,
not just a one-off slice. The dialog is owned by the host `SliceFileModal` and writes
the shared slice controller, so — like the filament-settings dialog's `materialEditListenerRef` —
the controller exposes a `processEditListenerRef` the editor points at
`recordMaterialsHistory`; the modal fires it **before** a profile switch / overrides
apply, so the edit lands in undo history and lights Save. On save, `useEditorSave` sends
the controller's `processSettingOverrides` as `SaveArrangedThreeMf.processSettingOverrides`;
`buildEditedThreeMf` merges them into `project_settings.config` via
`applyGlobalProcessOverrides` (verbatim, mirroring the slicer's own
`applyProcessSettingOverrides`). Deliberately routed through a `buildEditedThreeMf`
option rather than the `SceneEdit` contract so the slice path — which applies these via
the slice request instead — is untouched. On reopen the baked config becomes the
baseline, so the override map resets to empty (no phantom "modified" marker).

### An editor-born project bakes from the editor state, not from its own last save

A project **created** in the editor (the "New 3MF" scaffold, or a fileless start) keeps its
instances **import-backed for the whole session** — nothing re-reads the file to turn a staged
import into an in-project object. Its saves therefore set
`SaveArrangedThreeMf.ignoreBaseContent`, which makes the API skip the base file's *bytes* while
still using it as the save **target** (name/folder/bridge; a `newVersion` save still lands on it).

Why it matters: without it, each save re-injects the staged imports on top of the previous save's
output, and the base's now-unreferenced component objects are left behind. The *placed* instance
stays correct — `SceneEdit.instances` is authoritative for what is on the plate — so this is
invisible in the scene, but a multi-solid import strands **one dead mesh object per solid per
save**, and a large STEP assembly bloats the file every time the user hits Save. Baking from the
editor state alone reproduces the first save's output byte-for-byte, so repeated saves are stable.
That stability is what lets the editor **adopt** the saved file in place (`savedFile` in
`useEditorSave`) and stay open, instead of re-mounting on it — a plain Save used to look like the
project had reloaded, because a new project has no Save-version path and fell through to Save-As.

The scaffold itself is a hidden throwaway: `LibraryCreateAction` hands the host an `onDiscard`,
which `LibraryView` fires from `closeSliceDialog`. Cleanup is therefore tied to a **clean dialog
close** — a killed tab or a refresh skips it, and `pruneHiddenLibraryFiles` sweeps the remainder
after `LIBRARY_TRANSIENT_RETENTION_DAYS`. Note the historical trap: re-opening the editor on a
saved file (`onSavedAs` → `openSliceForSavedFile` with no opts) **overwrites that cleanup ref with
null**, so before the adopt-in-place change every save of a new project orphaned its scaffold.

The flag is **only** for editor-born projects. A project opened from a real library file must keep
reading its base: `rewriteThreeMfEntries` copies every entry it has no transform for through
verbatim, and that passthrough is the only thing preserving what `SceneEdit` cannot express —
`Auxiliaries/` attachments, plate thumbnails, `_rels/`, `[Content_Types].xml`, and whatever a
future BambuStudio adds. A new-project scaffold holds none of that: it is itself a from-null bake
of one plate and one default filament (`POST /api/editor/new-project`), both already modelled by
the editor state. A genuine **Save As** from an already-saved project still re-mounts on the new
file, deliberately — an older file stays behind, and re-reading is also what converts that
session's staged imports into in-project objects.

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
  BambuStudio's native attribute, retained in the saved 3MF so the object can be re-enabled.

Round-trip (reopen): `readSceneManifest` parses `<item printable="0">` back onto the scene
instance (`parseRootBuildItemPrintable`), so the editor seeds `EditorInstance.printable`
and a reopened project keeps its greyed objects. This read path is **API-only** — the bridge
does not parse build items (the shared parser only builds the index); the scene is always
assembled by `three-mf-reader.ts` from a locally-resolved file.

### How `printable="0"` actually excludes an object from the slice

The BambuStudio **CLI ignores the build-item `printable` flag** when slicing (and ignores
`<model_instance>` removal — it re-derives plate membership from build-item geometry; physically
deleting objects corrupts the `<assemble>` cross-references). The only mechanism the engine honors
is the `--skip-objects "<identify_id,…>"` command-line flag, keyed on each instance's `identify_id`
(stored as `loaded_id` by the loader). So `printable="0"` is purely an **in-3MF marker of intent**;
the slicer service is what enforces it: before invoking the CLI, `apps/slicer/src/skip-objects.ts`
(`deriveSkipObjectIdentifyIds`) reads the build items marked `printable="0"`, maps each one to its
instance's `model_settings` `identify_id`, and appends `--skip-objects`.

Both exclusion surfaces ride this path. The **slice/print dialog's per-object selection**:
`createObjectCustomizedThreeMf` (`three-mf-output.ts`) marks the deselected objects `printable="0"`
on the target plate. The **editor's per-instance Printable toggle**: the bake writes `printable="0"`
on the skipped instances' build items. The `identify_id`s both need are guaranteed by the bake:
`renderArrangedModelSettingsPlates` (`three-mf-scene-builder.ts`) writes one on **every**
`model_instance` — preserving the source project's ids for returning instances and minting fresh
unique ids for new/duplicated ones — so an editor-rewritten (or editor-saved) project stays
skippable. (Editor saves used to strip `identify_id`s, which silently broke per-object selection
on any previously saved project; such a project regains ids on its next save.) The skip mapping is
per **instance** — build items appear in instance-id order, so an object with a mix of printable
and skipped items skips only the toggled instances, while an object whose items are all
unprintable skips every instance.

## Calibration (plugin surface)

Filament calibration (`calibration` plugin: `apps/api/src/plugins/calibration/`,
`apps/web/src/plugins/calibration/`) is a **consumer of the slicing pipeline**, not a
third feature. It generates disposable calibration prints, runs them through the *same*
job queue and print dispatcher as any other slice, and saves the measured result per
filament identity for reuse. It never reaches into the editor or the pipeline internals —
it builds a 3MF on disk and hands it to `POST /api/slicing/jobs` like everything else.

Two calibration kinds, both built in `build-3mf.ts` from geometry in `geometry.ts`:

| Kind | Geometry | How the swept variable is encoded | Slice-time process overrides |
| --- | --- | --- | --- |
| **Pressure advance** (`pressureAdvance`) | one `tower_with_seam` tower (`pressureAdvanceTower`) | a `Metadata/custom_gcode_per_layer.xml` sidecar injects `M400` + `M900 K…` at each height band, so K steps up the tower | `PA_TOWER_PROCESS_OVERRIDES` — rear seam, 2 walls, no top/infill, and a brim (see the brim invariant below) |
| **Flow ratio** (`flowRatio`, pass 1/2) | a grid of patches (`flowRatioPlate`), one object per offset | each patch object carries its own `print_flow_ratio` metadata override (`currentFlowRatio * (100 + offset) / 100`) so one slice prints the whole ladder | `FLOW_PROCESS_OVERRIDES` — solid readable top surface at a neutral base flow |

**Run lifecycle.** A `CalibrationRun` row tracks state `slicing → readyToPrint →
printing → awaitingResult → saved` (or `discarded`/`failed`), managed by `run-manager.ts`.
The build produces a **hidden** library 3MF; `run-manager` enqueues it on the slicing job
queue (`processSettingOverrides` carry the per-kind overrides), reconciles the queue on
read to advance `slicing → readyToPrint` (recording the job's `outputFileId` on the run),
and dispatches through `print-dispatcher.ts` pinned to the chosen AMS tray via
`ams_mapping` (`calibrationAmsMapping` + `trayIndexToAmsSlot`). The web wizard
(`CalibrationSlicePrintModal`) tracks the slice inline and mirrors the library
slice-result UI — shared `SliceEstimates` panel + a **Preview** button that opens the
model-studio gcode overlay via the `library.overlays` `PluginSlot` on `run.outputFileId`
— but has no save-to-library (the run *is* the tracked entity).

**Result application** (measured best band → reused on matching filament):

- **Pressure advance K is printer-side, not slice-time.** `applyPrinterKValue` must
  *create the K profile and then select it* on the tray — creating alone does not apply it
  (see the hardware-verified note in the plugin). `autoApplyOnLoad` (on the
  `ams-slot.filament-loaded` bus event) pushes a filament's saved K when it is loaded into
  a slot, so a calibrated spool self-applies.
- **Flow ratio is a saved value keyed by filament identity.** `store.ts` persists a
  `CalibrationResult`; `resolution.ts` picks the best match by identity **specificity**
  (RFID/brand/preset over bare type). Tying a run to the loaded spool uses the pull-based
  `slotFilamentResolvers` registry (filled by `filament-manager`) — see the plugin guide.
- **Not yet wired: the SliceFileModal "calibrated flow" chip.** A saved flow ratio is
  *not* currently injected into an ordinary user print, and the slice dialog does not
  surface that a calibrated value exists for the selected filament. Wiring it means baking
  the resolved `filament_flow_ratio` into a normal slice **and** showing a chip in
  `SliceFileModal` — a core-dialog change that needs slice verification, so it is a known
  follow-up. (Pressure advance already reaches real prints via the printer-side path
  above, so it needs no such chip.)

## Invariants

- **A from-scratch project's settings must survive the save.** A new-project scaffold
  (`buildEditedThreeMf(null, …)`) embeds no `Metadata/project_settings.config`, so the save path
  synthesizes one: `buildEditedThreeMf` composes the filament / plate-type (`curr_bed_type`) /
  prime-tower rewrites onto `'{}'` and writes the entry when the base has none, and the editor's
  chosen machine rides the retarget path (built by the web even when the project has no source
  model; `retargetSavedProjectMachine` upserts from an empty object). The slicer side has the
  matching guard: `apps/slicer/src/project-settings-fallback.ts` completes an absent OR partial
  embedded config via a genuine `--export-settings` merge (overlaying the project's own values),
  because the CLI's BBL-project loader segfaults on structurally incomplete settings. Two
  hard-won specifics: a PROJECT-PRESET slice (`project:process:…`) loads no external profiles at
  all — the export args are derived from the preset names the embedded settings carry, resolved
  against the slicer's builtin catalog — and the export must always cover the FILAMENT domain
  (falling back to Generic PLA), because a filament-less export omits the per-filament override
  arrays (`filament_retraction_length`, …) and the bare loader segfaults on those alone.
  When the export itself FAILS (e.g. the CLI's exit 239 "process not compatible with printer"
  from a cross-model machine/process pairing), the guard throws with that reason instead of
  slicing the incomplete config — proceeding is always the deterministic segfault — keeping the
  `Slicer CLI exited with code N` message shape the API's slicing queue classifies for its
  drop-incompatible-builtin-profiles retry (`isLikelyBuiltinProfileCompatibilityExit`). The web
  dialog guards the same class at the source: a set-but-incompatible machine/process selection
  (state predating a printer switch) blocks submission with a named reason instead of reaching
  the slicer at all (`printerProfileIncompatible`/`processProfileIncompatible` in
  `SliceFileModal`).
- **`flush_volumes_matrix` is `filaments^2 x extruders`, not `filaments^2`.** BambuStudio stores
  one `filaments x filaments` block PER EXTRUDER (`PrintConfig.hpp` `get_flush_volumes_matrix`
  slices block `e`; `BambuStudio.cpp` sizes it `project_filament_count^2 * new_extruder_count`).
  A machine retarget changes the extruder count, so anything that rewrites project settings must
  re-derive the matrix for the NEW topology — `retargetProjectSettingsToMachine` and
  `applyFilamentList` both do, via `repairFlushVolumesMatrix`
  (`packages/shared/src/flush-volumes-matrix.ts`). Getting this wrong is not a soft failure:
  BambuStudio only repairs an undersized matrix inside its flush-volume recompute block, which it
  SKIPS unless `--filament-colour` was passed, the matrix is absent entirely, the extruder count
  differs from the project's own, or `nozzle_volume_type` mismatches — a retarget satisfies none
  of them, so the short matrix survives and the engine reads the missing block out of bounds:
  a deterministic SIGSEGV at ~71% ("Detect overhangs for auto-lift", CLI exit 139). An ABSENT
  matrix is safe (absence is one of the recompute triggers), so it is deliberately not flagged.
  Projects already saved with the defect are NOT healed at rest — the shared index parser flags
  them (`needsSettingsRepair` on the 3MF index and the `LibraryFile` DTO), the editor shows a
  banner on open, `SliceFileModal` blocks the library-flow slice with a named reason, and both
  offer the user an explicit Repair (`POST /api/library/:id/repair-settings`, which lands the
  corrected project as a NEW library version). An editor slice needs no gate: its bake re-authors
  project settings through `applyFilamentList` and is therefore already correct.
- **A project newer than the engine is refused, not degraded.** BambuStudio compares the 3MF's
  version against its own **major.minor only** and exits `CLI_FILE_VERSION_NOT_SUPPORTED` (-24,
  process exit 232) before loading anything, so no preset or retry can rescue the slice. The shared
  index parser surfaces the project's version (`projectVersion`, parser v17) and
  `packages/shared/src/bambu-file-version.ts` owns the comparison; `SliceFileModal` warns and
  blocks, and the user may override with an explicit acknowledgement that passes the CLI's own
  `--allow-newer-file` escape hatch. The override is deliberately not automatic: bypassing the
  vendor's gate lets an older engine silently misread newer settings, so a slice that succeeds is
  not proof the G-code is right. Beta engines can be bundled for this (`prerelease: true` in
  `apps/slicer/docker/slicer-targets.mjs`) but are never selected by default.
- **Calibration PA-tower brim must be `outer_only`, never `brim_ears`.** In our
  BambuStudio fork `brim_ears` is the *painted* brim type: it emits nothing unless manual
  ear points are painted into `Metadata/brim_ear_points.txt`, which the tower has none of,
  so a tall narrow tower would print with **no brim and poor adhesion**. `outer_only` is a
  full automatic perimeter brim (BambuStudio's own tower recipe sets no brim at all; ours
  adds one deliberately). See `PA_TOWER_PROCESS_OVERRIDES` in `run-manager.ts`.
- **Shared 3MF index parser.** The parsed *index* shape is produced by one shared module,
  `@printstream/shared/three-mf`, consumed by both `apps/api/src/lib/three-mf-reader.ts` and
  `apps/bridge/src/library-3mf.ts`. Changing the index shape means editing that parser once,
  updating the shared schema, and bumping `THREE_MF_INDEX_PARSER_VERSION` — see
  the API development notes and the bridge development notes. (The full scene parse —
  `three-mf-reader.ts`'s `readSceneManifest` — and all 3MF *writing*
  (`three-mf-scene-builder.ts`, `three-mf-output.ts`) live only in the api modules.)
- **Nozzle-id mapping** in the slicer's `output-metadata.ts` must stay byte-for-byte —
  see the slicer development notes.
- **A `slice_info.config` record must describe the project's CURRENT filament set, or not exist.**
  It records one `<filament>` entry per filament a PREVIOUS slice used, and BambuStudio builds its
  per-plate nozzle grouping from those entries
  (`MultiNozzleUtils::load_nozzle_infos_with_compatibility` consumes `slice_filaments_info`). A
  record covering fewer filaments than the project has makes the engine derive a SHORT filament map
  and read it out of bounds, aborting the slice on a garbage extruder id (issue #63: a project
  sliced with one material, then given a second, failed with "can not be printed on extruder
  21840"). The editor save therefore DROPS a record that no longer matches the filament set it is
  saving (`three-mf-scene-builder.ts`) rather than carrying it forward: the per-filament usage a
  slice produced cannot be invented for a material that was never sliced, so the honest state is no
  record until the project is sliced again. `sliceRecordFilamentIds` in
  `@printstream/shared/three-mf` is the shared check.
- **A manual dual-nozzle assignment must be passed on the CLI, not only written into the 3MF.**
  The MODE comes from the per-plate `filament_map_mode` metadata in `model_settings.config`; the
  MAP goes on the `--filament-map` flag (`apps/slicer/src/filament-map-args.ts`, comma-separated,
  one entry per filament). BambuStudio takes `filament_map` from its command-line config, falling
  back to the plate's map and then to a one-entry default `{1}`; when that fallback reaches the
  default, the manual-mode check reads it out of bounds and aborts with a garbage extruder id
  (issue #63). The flag removes the dependency on that fallback. Keep writing the map into the
  3MF so the saved artifact matches the gcode, but do not rely on it to take effect.
- **Editor nozzle assignment** (`SceneEditFilament.nozzleId`, 0 = right / 1 = left) is persisted on
  save by `three-mf-scene-builder.ts`: `filament_nozzle_map` is written **verbatim** as the runtime
  nozzle id (same inverse-free mirror as the slicer, per that same invariant), each `slice_info`
  `<filament>` `group_id` is moved onto the chosen nozzle (it outranks `filament_nozzle_map` once a
  project has concrete slice usage), and `extruder_nozzle_stats` is rebuilt so a stale single-active
  reading can't short-circuit every filament onto one nozzle. The read side (`extractNozzleMapping`)
  and this write side share `sliceExtruderForNozzleId` so they cannot drift; cover any change with a
  read→write→read round-trip through `buildThreeMfIndex`.
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
