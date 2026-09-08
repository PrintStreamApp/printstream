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
| **Editor** | web | `apps/web/src/plugins/model-studio/` — `EditorView.tsx` (3D editor), `lib/editorModel.ts` (the editable scene model + `buildSceneEdit`), `lib/editorProjectSource.ts` (where the project is READ from — see below), `lib/threeMfScene.ts` (scene→Three.js), `lib/editorImports.ts`, `lib/meshCut.ts` (Cut tool: plane cut + capped halves, oriented per half, staged as imports) |
| **Editor** | api | `routes/editor.ts` (save, staged imports, and the no-persist `POST /export-3mf` download bake), `lib/import-store.ts`, `lib/mesh-import.ts` (STL parse + STEP tessellation), `lib/three-mf-mesh-extract.ts` (3MF geometry import: first non-empty plate → one part per placed part, helper volumes CARRIED with their subtype but excluded from the merged mesh + re-centring, group re-centred on origin); `lib/three-mf-scene-builder.ts` (`buildEditedThreeMf`) |
| **Slicing** | web | the slice UI in `components/library/` — `SliceFileModal.tsx`, `SliceSettingsPanel.tsx` (`SliceSettingsController`; materials render as compact one-line swatch rows), `MaterialEditDialog.tsx` (the expanded per-material type/preset/color inputs, reached from a swatch row via `MaterialSwatchButton.tsx`, whose menu also assigns the printer's loaded materials directly), `FilamentSettingsDialog.tsx` (material settings) — plus `components/ProcessSettingsDialog.tsx`, `components/settings/MachineSettingsDialog.tsx` (printer presets, from the slicing-preset manager) and the per-object settings surfaces inside `SliceSettingsPanel.tsx` and the editor's `editorPanels.tsx`. All three settings dialogs share `components/settings/SettingsCatalogDialog.tsx` + `SettingValueField.tsx` |
| **Slicing** | api | `routes/slicing.ts`, `lib/slicing-jobs.ts`, `lib/slicer-client.ts`, `lib/slicing-presets.ts` |
| **Slicing** | slicer | `apps/slicer/**` — the standalone BambuStudio CLI service (profile resolution, machine-switch, output metadata) |
| **Shared 3MF model** | shared | `packages/shared/src/slicing.ts` (`SceneEdit`, slicing job contracts), the scene/index schemas in `printer.ts` |
| **Shared 3MF model** | api/bridge/shared/web | the `apps/api/src/lib/three-mf-*.ts` modules own the Node ZIP I/O (read + write, re-exported via the `three-mf.ts` barrel); the pure transforms live in `@printstream/shared/three-mf` — the **index** and **scene** parses, and the whole bake (`bake-documents`, plus `object-clone`, `mesh-repair`, `xml-write`). Shared by `three-mf-reader.ts`, the bridge's `apps/bridge/src/library-3mf.ts`, and the web's client-side 3MF surfaces (no hand-kept mirror) |
| **Printer retarget** | shared/api | "Save as a different printer" — rewrites a project's machine + process settings (no slicing). `packages/shared/src/machine-retarget.ts`, `apps/api/src/lib/save-retarget.ts`. See `docs/project-printer-retarget.md` |
| **Calibration** | api/web plugin | Builds disposable calibration prints (PA towers, flow plates) and runs them through the slicing pipeline + dispatcher. `apps/api/src/plugins/calibration/**`, `apps/web/src/plugins/calibration/**`. See "Calibration (plugin surface)" below |
| **Public editor** (web host) | web | The server-less host of the SAME `EditorView`, at `/3mf-editor` — `apps/web/src/PublicToolApp.tsx` (shell), `LocalProjectEditor.tsx` (file picker + archive), `LocalEditorSurface.tsx` (mounts the editor + the dialogs no slice modal renders), `useLocalSliceSettingsController.ts`, `LocalSlicingPresetsDialog.tsx`, and the `lib/local*.ts` seams (project source, save target, import store, process/filament resolvers, machine retarget, browser preset storage). See "The public editor" below |
| **Public editor** (anonymous api) | api | `routes/public-slicing.ts` — the anonymous catalogue (`/api/public/slicing/*`): profiles, targets, bed-model, flush-data/flush-calibration, and builtin-ONLY `resolve-process` / `resolve-filament` / `resolve-machine` |

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
| Independent copy | negative placeholder `objectId` | `objectClones` pre-pass (shared `three-mf/object-clone.ts`) |
| Data riding the save/slice REQUEST, not the edit | the same editor-side id | `replacedObjectIds` / `clonedObjectIds` + `rekeyReplacedObjectOverrides` |

The failure has a quiet form worth watching for: a collector in `buildSceneEdit` whose
`placedObjectIds` set is built only from `source.kind === 'object'` accepts the user's edit in the
UI and then drops it at bake time, with no error anywhere.

## The editor reads the whole archive, and nothing else

Opening a project downloads the entire 3MF (`GET /api/library/:id/archive`, or the matching
`/versions/:versionId/archive`) and parses it in the tab. `lib/editorProjectSource.ts` is the seam:
`createArchiveProjectSource` for the library host, `createLocalProjectSource` for a host that
already holds the file (the public editor). **Both serve every read — index, per-plate scene, mesh
entries, plate thumbnails — from an inflated archive, through the same
`@printstream/shared/three-mf` parsers.** The editor no longer calls `/plates`, `/scene`, or
`/scene-entry`; those routes remain for the read-only preview and the slim slice/print dialogs,
which want the parsed index and nothing more.

Three things follow, and they are the reason for the design:

- **One scene, not two.** While the library host read a server-parsed index and the public host
  parsed its own, the same file could open differently in each, and did.
- **The session is self-sufficient after open.** The project is in memory, so nothing mid-session
  has to ask the server to re-read the file. This is the read half of "author anew": the bytes we
  opened are the bytes we author the next save from.
- **Permission posture.** `/archive` is gated on `library.view`, not `library.download`, so every
  actor who can open the editor still can. The consequence is deliberate: a viewer's tab holds the
  whole file, so `library.download` governs the download *affordances* (export, save-to-disk) and
  is not a hard boundary on the bytes of an openable 3MF.

What it did **not** buy is a faster open. Profiling a 145-object / 21MB project showed every scene
request finishing at 3.7s against ~8s of main-thread work building the scene: the byte source was
never the bottleneck, and blocking is unchanged. The wins are the three above plus a cheap reopen
(the archive revalidates to 304).

Three notes in place because they bit:

- **Serve the archive through `sendModelBuffer`, never a bare `createReadStream().pipe()`.** A raw
  pipe is fine for `/download` (the browser writes it to disk) but its body never completes when
  read back through `fetch().arrayBuffer()` behind the Vite dev proxy — headers and most of the
  body arrive, the tail never does, and the editor hangs on open with no error. Verified directly:
  curl fetched the same URL in 37ms while the browser hung indefinitely.
- The archive uses its own body-stall budget (`ARCHIVE_STALL_MS`) and does not retry: a
  bridge-owned file is pulled, read, and compressed in full before a byte reaches the browser, so
  time-to-first-byte scales with the whole project on a cold open.
- **A short body must FAIL, not corrupt.** `sendModelBuffer` declares a `Content-Length`, so a body
  that ends early is rejected by the browser instead of being handed to the unzip as a truncated
  buffer — which surfaces as "this file could not be opened as a 3MF archive" and blames the file
  rather than the transport. This matters most because the route is conditional and the ETag is
  derived from METADATA, never from the bytes sent: a body that went out wrong still carries a
  valid-looking tag, gets stored, and every later open revalidates into it. One project stayed
  unopenable in one browser while the identical bytes opened everywhere else. When a bug could have
  put a bad body in a cache, fixing the server is not enough — bump `ARCHIVE_ETAG_VARIANT` to
  orphan those entries.

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
the single predicate for it), `objectNames` (renames), and the four paint channels `supportPaint` /
`seamPaint` / `colorPaint` / `fuzzyPaint` — the support, seam, colour, and fuzzy-skin brushes'
complete per-part triangle paint maps (`paint_supports` / `paint_seam` codes: `'4'` enforcer, `'8'`
blocker; `paint_color` whole-triangle states map to 1-based filament ids, '4'/'8'/'0C'/
'1C'...; `paint_fuzzy_skin` is its own attribute even though BambuStudio gives fuzzy skin the same
VALUE as a support enforcer, because a triangle can be both; longer split codes from the source file
are preserved verbatim). A channel is only as good as its READ path: the attribute must be picked up
by every parser and both worker-wire hops (`TRIANGLE_PAINT_SOURCES` in the editor's
`meshParseCore.ts` is the one table they all derive from), because these maps are complete state, so
a channel that fails to load saves back as empty and erases what the file had. The api rewrites a painted
part's `<triangle>` attributes inside the mesh's model entry (root or
`3D/Objects/*.model`); parts never painted in the session are copied byte-for-byte —
unless the save PERMUTES the filament slots (a material reorder or mid-list removal), in which
case the bake re-keys every entry's `paint_color` codes through the old→new slot map
(`remapColorPaintInModelXml` in the shared `three-mf/triangle-paint-codec.ts`), because colour
paint states ARE 1-based filament ids and stale codes silently print painted regions in whatever
material now holds the old number. The same permutation pass re-keys part/object `extruder` and
filament-index metadata in `model_settings.config`, tool changes on unedited plates in
`custom_gcode_per_layer.xml`, the scalar filament-index process keys and layer print sequences in
`project_settings.config`, and drops a same-count `slice_info.config` (its per-id records and
group ids describe the old order).
The editor parses existing paint from the scene-entry XML (`lib/threeMfScene.ts` →
`geometry.userData.supportPaint`/`seamPaint`), renders each channel as a
vertex-coloured overlay (blue/red supports, green/orange seam), and authors paint with
Bambu-faithful tools (`lib/supportPaint.ts` + `lib/trianglePaintTree.ts`): sphere and
circle (view-ray cylinder) brushes that grow from the hit triangle over shared edges
and split partially covered triangles to `min(radius/5, 0.2mm)` edges, swept along the
stroke between pointer samples so a fast drag paints a continuous band rather than a row
of dabs (BambuStudio's interpolated positions plus its `DoublePointCursor` capsules; see
the plugin guide for the rules that come with it), smart fill
(flood across edges while neighbouring normals stay within an angle limit), and on the
colour channel single-triangle painting, same-state bucket fill, and a height-range
band (split crisply at the world-z planes). Brush options mirror Bambu's: edge
detection (colour brushes stop at sharp edges) and on-overhangs-only for support
painting (world-normal gate that also blocks propagation). `brimEars` carries per-object manual brim
ears (object-local points + radius), written wholesale to Bambu's
`Metadata/brim_ear_points.txt` (objects referenced by 1-based root-resource ordinal);
`readSceneManifest` parses the sidecar back onto scene instances so reopened
projects keep their ears. `heightRanges` is the same shape one level along: per-object Z bands
(object space, z=0 at the model's underside, `[minZ, maxZ)`) with the process settings each band
overrides, written wholesale to `Metadata/layer_config_ranges.xml` by the same 1-based ordinal and
parsed back the same way. An authored ranges file SKIPS the ordinal remap that carries an untouched
one through, since it already speaks the saved ordinals. Every band must name a `layer_height`:
BambuStudio reads that key without checking it exists. `layerHeightProfiles` is the free-form
sibling: a per-object curve of alternating z/height pairs written to
`Metadata/layer_heights_profile.txt`, generated by the adaptive pass, smoothing, or the thickness-bar
brush (`three-mf/layer-height-adaptive.ts`). It TAKES PRECEDENCE over `heightRanges`' layer heights,
so both editor surfaces warn when an object carries both. `filamentChanges` and `pauses` carry per-plate layer-based
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
persists ModelVolume config, so the slicer applies them inside the volume.

A part authored by a TOOL also carries what it was MADE FROM, so it reopens editable
rather than as anonymous solids: `textInfo` for the text tool (BambuStudio's
`<text_info/>`), and `svgPart` for the SVG tool (our `<printstream_svg/>`), with
`bambuShape` (Studio's `<BambuStudioShape/>`) alongside the latter only when the
import produced a SINGLE part. That element describes a whole artwork, so one on each
of N split parts would tell Studio every mark is the entire drawing. The codecs and the
rules live in one place, `@printstream/shared/three-mf` `svg-shape.ts` and
`text-info.ts`. Neither SVG record stores the shapes themselves: both name a
`3D/<name>.svg` archive entry, whose bytes ride the edit as `SceneEdit.svgSources` and
which both readers re-parse on open, so an edit naming an entry nobody wrote produces
parts that are exactly as un-editable as ones with no record at all. `svgSources` emits
only entries a surviving part still references, and each `entryPath` is constrained to
`3D/<name>.svg` at the wire boundary: the bake writes it verbatim as an archive entry
and both writers key entries last-wins, so an unconstrained value could replace the
model document. Artwork is capped per file AND across the request, because the markup
rides every subsequent save and the transport rejects an oversized body before
validation runs, which would otherwise break save and slice alike with nothing naming
the SVG. Hosts
carrying an inline mesh are first wrapped (mesh moves to its own object behind an
identity component) so 3MF's mesh-XOR-components rule holds — the normal path for a
freshly baked import host. Painting and brim ears work on unsaved imports too — they
ride their own seams (`importPaint`, `importBrimEars`, `importHeightRanges`,
`importLayerHeightProfiles`, and `repairedImportIds` for mesh repair) keyed by import id rather than by a baked `object_id`, so a staged import, a
Cut/Split half, or an independent copy can be painted before the project has ever been
saved. The rule that forces this shape: no editor feature may require a save first, so a
per-object or per-part seam addresses the model by its editor-side identity and resolves
that to a real object id server-side at bake time.
A SESSION-ADDED volume paints through that same `importPaint` seam and needed no seam of
its own: its mesh IS a single-solid `part` import, so its paint is solid 0 of that import
and the bake already writes it through `renderImportedMeshObjectXml`. Only the client had
to learn: the `supportPaintPart` tag is what makes a mesh a raycast candidate at all, so
an untagged volume was not merely unpaintable, the brush passed through it onto the body
behind.
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
(shared `three-mf/object-clone.ts`) deep-copies the source object's XML, its `model_settings` entry, and
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
objectId+partIndex (baked parts, applied by rewriting the Nth `<part>`'s `subtype`
attribute), the second by importId+solid index (unsaved multi-solid imports, whose parts
are baked with the chosen subtype instead of `normal_part`). Retyped parts render as
translucent volumes and per-part process overrides apply inside them, exactly like
added modifier volumes.

`partTransforms` carries part-placement edits (moving / rotating / scaling a BAKED part
inside its object — e.g. repositioning a support blocker after a save): keyed by
objectId+partIndex with the part's new object-local 12-number matrix. The writer
rewrites the part's `<component transform>` — the placement BambuStudio and the CLI
slicer actually load into the volume (verified against the BambuStudio reader:
`model_settings`'s `matrix` metadata only feeds `volume->source.transform`) — and
mirrors the `matrix` metadata (row-major 4x4) when present so a later BambuStudio
re-save doesn't compound a stale source record. Placement is geometry-level, shared by
every placed instance of the object.

`removedParts` / `importRemovedParts` carry per-volume DELETE: the first keys by
objectId+partIndex (dropping the Nth `<component>` from the model and the Nth `<part>`
from `model_settings.config`), the second by importId+solid index (filtering a
multi-solid import's staged solids before they are baked). It is the only SUBTRACTIVE
part seam, and it has to exist because none of the others can express a removal:
`SceneEdit.instances` is a COMPLETE list, so omitting an instance deletes the object and
the unreferenced-object sweep takes its geometry, but parts live only in the base file's
object XML and are addressed by ordinal, so a part's absence from an edit means "leave it
alone". Three rules, all of which fail silently rather than loudly. Removals are applied
LAST, after every other part-scoped seam, because they all address BASE-file ordinals and
removing first would shift each edit onto a neighbouring volume. The client never
renumbers the survivors either, which is what keeps those ordinals meaningful. And an
import's surviving solids are filtered by SOURCE index, with the multi-part path chosen
on the ORIGINAL solid count, since the single-mesh fallback is the MERGED mesh and would
reinstate the geometry just deleted. An object's last printed part cannot be removed;
deleting the object is the action for that.

`removedObjectBodies` is the third removal, and it exists because the two above cannot
express it: an object whose geometry sits on an inline `<mesh>` has no `<part>` entry to
omit. The bake CREATES one while attaching added parts (`applyAddedParts` moves the mesh
into its own object as component 0 and re-keys the host's own entry onto it), so "remove
ordinal 0" names something that does not exist until mid-bake, and `importRemovedParts`
cannot stand in because it filters SOURCE SOLIDS and no-ops for the single-solid imports
(a primitive, an STL, a cut half) this is mostly about. Flagged instead, so the component
is never created: the object is written with its added parts as its whole component list
and they keep their OWN names. Keyed `objectId` XOR `importId`, like `addedParts`, because
the host may never have been saved. Without it the editor had to promote a volume into the
body, and a promoted body is named after the OBJECT, so the same delete produced
`["Cube","Part"]` before a save and `["Part","Part"]` after one. That is the general lesson
rather than a detail of this seam: a difference that only appears one save later is still a
save changing what the user sees, so the fix belongs in what gets WRITTEN.

## Sidebar order is data, and both halves are portable

Objects and parts drag to reorder in the sidebar (BambuStudio's `ObjectList` drag), through the
shared `hooks/useListReorderDrag.ts` + `lib/listReorder.ts` that the plate strip and the materials
list already use. Rows are GROUPED and a drag cannot cross groups, which is what enforces "a volume
never leaves its object". Neither order is a view preference: both are written into the file in the
form other software already reads.

**Object order rides the BUILD ITEMS, and needs no dedicated field.** BambuStudio builds its object
list by walking `<build><item>` and creating one `ModelObject` the first time an id appears
(`bbs_3mf.cpp` `_create_object_instance`); a later item for the same id only adds an instance. So the
item order IS the displayed order, and since `renderArrangedBuildItems` emits items grouped by object
in `SceneEdit.instances` order, the sidebar order lands in the file directly. **Object ids are never
renumbered.** An earlier attempt at this permuted object ids to make them ascend in sidebar order and
was reverted (issue #73), on the belief that BambuStudio rebuilt its list from an id-ordered map.
That was a misreading: `IdToModelObjectMap` maps id to an INDEX into `m_model->objects`, and it is
that vector, built in build-item order, which the list walks. Verified against the real thing, since
Studio's own exporter correlates the two and its files therefore cannot tell the readings apart: a
137-object customer project whose item, resource and id orders all differ came back from the
BambuStudio 2.7.1 CLI in the input's ITEM order, all 137. Not renumbering is what makes this cheap:
every id-keyed structure in the live session stays valid, so none of the re-keying the revert warned
about is needed.

Three consequences that are easy to miss. The unit an order can address is the OBJECT, not the row:
a linked copy is one entry in BambuStudio's list, so a drag carries every instance of its object,
and the editor lays instances out grouped by object (`groupPlateInstancesByObject`) so the sidebar
shows what the file will contain. The order is PROJECT-wide, not per plate (`projectObjectOrder`,
`moveObjectBefore` takes the whole `EditorState`): the bake flattens every plate into one build
section, so an object placed on two plates cannot sit third on one and first on the other, and a
per-plate order silently lost the drag on the second plate the next time the project was opened.
And `<model_instance>` is written through the SAME grouping as the build items, because BambuStudio
ignores that order (it reads the blocks into a map keyed by object id) while OUR scene parser seeds
the sidebar from it: writing it ungrouped reopened a saved project with an object's copies split
around another object.

**Part order rides `partOrder` / `importPartOrder`**, each entry the object's complete desired
sequence of BASE ordinals. Ordinals, not `componentObjectId`: that is the MESH id, and BambuStudio
writes one id for every volume sharing a mesh, so an object can hold four parts a mesh-id order
cannot tell apart. The order carries slicing meaning (the engine requires the first volume to be a
normal part), which is why it is persisted rather than kept as a UI preference. It is applied in the
SAME pass as `removedParts` (`applyPartLayout`, resolving both through `resolvePartLayout`) because
neither can run after the other: both address base ordinals, so reordering first moves the ordinals a
removal names and removing first moves the ordinals an order names. **The model's `<component>` list
is the volume list and `model_settings` follows it**, so the two documents share ONE layout:
BambuStudio's `_generate_volumes_new` loops over an object's components and looks each one's `<part>`
metadata up positionally, guarded by an id check, falling back to an id search and then to defaults.
A `<part>` list of a different length is therefore not a positional mirror and is left alone -- one
that matches no component is never read, while a permuted one puts a name, subtype and extruder on
the wrong volume.

**A part-scoped WRITE resolves its ordinal the way BambuStudio resolves a read**, through
`resolvePartBlockIndex`: positional, guarded by an id check, then a linear id search, then nothing.
The ordinal is a position in the `<component>` list (that is the list the scene parser walks when it
mints them, pairing each component with its `<part>` metadata by mesh id), so a writer that indexed
`<part>` positionally was assuming the two lists mirror each other. They usually do, and nothing
asserted it: a file where they do not, a foreign export, or an object left un-permuted by the
length guard above, silently landed every per-part material, subtype, override and matrix on the
wrong volume, and each later save re-applied the same skew. Positional has to win where it AGREES,
which is why the id check comes first: BambuStudio writes one id for every volume sharing a mesh
(`m_share_mesh`), so an id-first lookup would collapse all of them onto the first. A volume no
`<part>` describes is SKIPPED rather than written onto an unrelated block, which is what the engine
already does with such a file (it reads that volume with default settings). The client prunes a removed ordinal out of the recorded order for the same reason
Studio never has the problem: `ModelObject::volumes` IS the order, so a delete erases from it, and
"reorder then delete" and "delete then reorder" have to reach one payload rather than two. A PARTIAL order shuffles only the
ordinals it names, through the slots they already occupy, so it can never drop a volume; that is the
normal shape whenever a removal is also pending, not just a stale-edit defence, because a removed
part is already gone from the client's part list and so is absent from the order it records.

**Which BASE those ordinals are counted over is PINNED, and a slice must send the pin exactly as a
save does.** A `SceneEdit` is a diff against the bytes the editor session OPENED, and the session
never renumbers its ordinals, so every bake of that edit has to read those same bytes. The pin is
`contentBase` (`apps/web/src/plugins/model-studio/lib/contentBasePin.ts`, resolved server-side by
`apps/api/src/lib/library-content-base.ts`), and it may move exactly ONCE, from "that file's head"
to the durable version id the first save archives, which is the same bytes under a name that will
not move again. The save has always sent it. The SLICE did not, and instead named only
`sourceFileId`, whose head is the session's own latest save: so slicing after saving in one session
re-applied an edit the save had already baked in. Most of the edit is idempotent and survived that,
but `partOrder` and `removedParts` are not, and a re-applied reorder permuted an object's volumes
while the per-part `extruder` values stayed on their old positions. Parts silently traded materials,
and a two-colour plate printed with the colours swapped. Both paths now resolve their base through
one function, so they cannot diverge again; a pin that no longer resolves is a hard error rather
than a quiet fall back to the head, because falling back is the corruption.

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
`3D/Objects/*.model`) and runs the shared `three-mf/mesh-repair` **in place** on just those meshes: a
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
per-device localStorage override, both edited from the **editor settings dialog**
(`components/settings/SlicerDeveloperModeCard.tsx`, rendered by
`components/library/EditorSettingsDialog.tsx`). It sits there rather than in Settings
because it decides what the editor's own process-settings dialog shows; the Settings >
Slicing page held nothing else and is gone. The card is not gated on `canManageSettings`
— it carries that gate itself (shared default read-only without the capability, per-device
override personal) — and the public editor omits it, having no workspace to read a shared
default from. The editor reads the effective
value through `useEffectiveSlicerDeveloperMode` (`apps/web/src/lib/slicerDeveloperMode.ts`);
the tier gate is `isProcessOptionVisibleInMode` in
`packages/shared/src/process-settings.ts`. Revealed options still obey the usual
conditional visibility rules.

### One dialog shell, three catalogs

The process, filament and machine editors share their chrome — title, search, "Changed only",
the page tabs with their modified emphasis and per-page counts, the grouped body, and the
footer's Reset all / Cancel / Update preset / Save as preset / Apply. That lives in
`components/settings/SettingsCatalogDialog.tsx` (with `SettingsCatalogLineRow.tsx` for a line
and `catalogDialogFilter.ts` for the pure "is this key on screen" rules). Each dialog supplies a
`SettingsCatalogAdapter` (`components/settings/settingsCatalogAdapter.ts`) describing only what
it alone knows: how to read and write a value, and what counts as changed.

The split is deliberate. The three value spaces are genuinely different — the process dialog runs
a conditional field-state engine and a per-object override mode, the filament dialog edits element
0 of per-variant vectors and broadcasts back, the machine dialog edits one vector column per
extruder — but the chrome around them is not, and while it was copied per dialog it drifted: one
footer wrapped on a phone and one did not, one counted tab matches under "Changed only" and one
only under the search box, and the same button was called a preset in one and a profile in the
other. Add a fourth catalog by writing an adapter, never by copying the shell.

### Machine (printer) presets are edited by column, not by element 0

`MachineSettingsDialog` is the printer editor, reached two ways: the slicing-preset manager's
Printer tab, and the gear beside the **Preset** row in the slice sidebar's Printer section (which
names the machine preset that Model + Nozzle + Flow resolved to — see
`lib/machineTargetResolution.ts`). The sidebar mounts it itself rather than delegating to its host
the way the process and material dialogs do, because it edits a stored preset and returns nothing
for a host to merge; the host only answers `canEditPrinterPreset`, which the public editor sets
false. The all-kinds **Manage presets** button sits in that sidebar's *Slicer* header, the one
heading whose scope is the whole panel.

It has no project branch: a 3MF embeds its filament and process settings but only *names* its
printer, so a machine preset is always an installed one — no `sourceFileId`, no baked overrides, and
no Apply (it runs at `applyScope: 'preset'`). Its base config comes from
`POST /api/slicing/profiles/resolve-machine`, which also returns the parent preset as `baseConfig`
when the preset declares `inherits`.

Over half the machine catalog's 77 options are vectors, and **their elements are indexed by
different things per page** — which is why `machineColumnsForPage`
(`packages/shared/src/machine-settings.ts`) is page-driven rather than a property of the option:

- **Extruder page** — one element per extruder, counted from `nozzle_diameter`'s length exactly as
  `TabPrinter::build_unregular_pages` does. Labelled "Extruder 1"/"Extruder 2"; a single-extruder
  machine gets one unlabelled column, matching BambuStudio's unnumbered "Extruder" page.
- **Motion ability page** — element 0 is Normal mode and element 1 is **Silent** mode, *not*
  extruders (`build_kinematics_page` appends index 1 only behind `m_use_silent_mode`, i.e.
  `silent_mode`). Treating these as extruder columns is the easy mistake.
- **Everywhere else** — element 0 only. `nozzle_type` is a vector but its Basic information line is
  an `append_single_option_line` with no index, so BambuStudio shows the first element alone.

Collapsing a vector to element 0 (what `createProcessConfigAccessor` does, and therefore what the
process dialog does) would silently edit extruder 1 of an H2D and leave extruder 2 unreachable.

A save writes the **full resolved config** through `buildMachinePresetConfig`, laying only the
catalog keys the user could see over it. BambuStudio's printer tab edits the rest through bespoke
widgets this dialog does not have — the printable area, bed shape and exclusion zones, the
model/variant identity — and those are absent from the catalog by design; assembling a save from
the editable keys alone would drop them and quietly rebuild the preset around a different bed.

### Global process settings persist through the editor's save

Global (project-wide) process edits made in the editor persist into the saved 3MF,
not just a one-off slice. The dialog is owned by the host `SliceFileModal` and writes
the shared slice controller, so — like the filament-settings dialog's `materialEditListenerRef` —
the controller exposes a `settingsEditListenerRef` the editor points at
`recordMaterialsHistory`; the modal fires it **before** a profile switch / overrides
apply, so the edit lands in undo history and lights Save. On save, `useEditorSave` sends
the controller's `processSettingOverrides` as `SaveArrangedThreeMf.processSettingOverrides`;
`buildEditedThreeMf` merges them into `project_settings.config` via
`applyGlobalProcessOverrides` (verbatim, mirroring the slicer's own
`applyProcessSettingOverrides`). Deliberately routed through a `buildEditedThreeMf`
option rather than the `SceneEdit` contract so the slice path — which applies these via
the slice request instead — is untouched. On reopen the baked config becomes the
baseline, so the override map resets to empty (no phantom "modified" marker).

### The project's own machine settings (a modified printer, scoped to one project)

The machine twin of the section above, and it exists because a 3MF genuinely embeds its machine
VALUES: `project_settings.config` carries the full machine block `retargetProjectSettingsToMachine`
writes (bed, nozzle, extruder topology, machine gcode, limits), not merely the printer's NAME. So
"modified versus the preset, saved in this project" is representable for a printer exactly as it is
for a process, with no new file format. `MachineSettingsDialog` runs at `applyScope: 'project'` in
the editor (`'slice'` in prepare-print, `'preset'` on the settings page) and emits the diff against
the resolved preset as `machineSettingOverrides`.

Six rules, five of which fail silently when broken:

- **Applied AFTER the machine step, always.** Overrides and the resolved preset write the SAME keys,
  so any earlier position lets the preset overwrite the user's values. The api applies them as the
  last machine-domain pass of the save (`applyMachineOverridesToProject`) and inside
  `authorSliceSettingsIntoProject` for a slice, which `slicing-jobs.ts` runs after the machine step;
  the browser host carries them on `MachineRetargetPlan.machineSettingOverrides`.
- **`--load-settings` presets WIN over the project's embedded values**, so the override is also baked
  into the machine preset file the CLI loads (`apps/slicer/src/index.ts`), not just into the 3MF.
  Without it an edited printer is reverted to stock at slice time.
- **A topology change re-derives the flush sizing.** An override may legitimately change
  `nozzle_diameter`, and with it the extruder count, so `applyMachineSettingOverrides` re-runs
  `repairFlushVolumesMatrix` / `repairFlushMultiplier` (an undersized matrix segfaults the engine at
  exit 139; a stale `flush_multiplier` fails its size check at exit 156).
- **Written into BambuStudio's OWN record, at `filament_count + 1`.** `applyMachineSettingOverrides`
  records the keys it wrote in `different_settings_to_system`'s MACHINE slot, which is what makes
  the file reopen as the user's own edit rather than as drift. That slot is found from the FILAMENT
  COUNT and never from the array's length: the engine resizes `different_settings_to_system` and its
  twin `inherits_group` to `filament_count + 2` INDEPENDENTLY and reads the printer slot at
  `filament_count + 1` (`BambuStudio.cpp:3200-3215`, `PresetBundle.cpp:1383,3885`), so on a project
  whose two arrays disagree (which the Repair stage routinely leaves, since it fixes one and not the
  other) `length - 1` lands in a FILAMENT slot. Both arrays are owned by
  `packages/shared/src/three-mf-project-config.ts` and `parallel-preset-record.guard.test.ts` fails
  the build on a new hand-rolled writer; it found one the day it was added.
- **An EMPTY override map means "reset them all", not "nothing to do".** The three gates between the
  dialog and the file (`useEditorSave`'s collector, the save route, the applier) each dropped an
  empty map as a no-op, so clearing an override saved successfully and the next open brought it
  back. A key the user reset is also put back to the preset's VALUE, not merely un-recorded (the
  engine reads the value), and stays recorded when there is no preset to restore it from, rather
  than leaving the file claiming one thing while slicing another.
- **Read back from BambuStudio's OWN record, never from a value diff.** On reopen the overrides are
  re-hydrated by `POST /api/slicing/profiles/resolve-machine` with a `sourceFileId`. The reading
  itself is `readMachineSettingOverrides`, which lives beside the writer in
  `packages/shared/src/machine-retarget.ts`: the two were a page apart in different workspaces and
  disagreed about the slot for a release, which is invisible from either side (the save succeeds,
  the file is well-formed, the override is simply gone). `machine-override-roundtrip.test.ts` drives
  the pair against each other across filament counts rather than asserting either alone. A value
  diff against the resolved preset is unusable and was measured as such on a real project: 44
  "overrides" of which essentially none were user edits, because `best_object_pos` serializes
  `0.3,0.5` in the project and `0.3x0.5` in the preset, every per-extruder and per-print-mode vector
  differs only in LENGTH while every value matches, and keys the preset does not define read as
  changes. Badging that count is a confident lie, and applying it writes 44 values into the project
  as though the user chose them. An ABSENT record means `{}`: unknown is not modified.

They are kept, not cleared, when the printer changes, and the panel says so
(`machineOverridesCarriedWarning`) because an override authored against one machine can express
something another cannot; the dialog's per-key reset is the escape hatch.

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

## The sliced project is kept, so a print can be sliced again

Print history is otherwise G-code-deep: `PrintJob.fileId` points at an immutable snapshot of the
dispatched artifact, and "Reprint" re-sends exactly those bytes. That is right for "print that
again", and useless for "print that again with one thing changed" — the project it came from was
never recorded, and for a slice started from the editor it may never have existed in the library
at all.

So every successful slice also preserves its **project**: `sourcePath` at the moment
`runSlicerJob` hands the file to the engine, which is after our rewrites (arranged scene, object
selection, per-object process overrides, layer G-code edits, authored machine, mesh weld) and
before the slicer's own mechanical prep (`input.materials.3mf`: machine retarget, filament-map
injection, `slice_info` stripping). That boundary is the point: everything above it is user
intent, everything below it is a CLI workaround that must not be baked into a project the user
will re-open.

That file alone would not be enough, because a slice carries settings that never entered it: the
process preset, the per-slot filament presets, the per-slice and per-material setting overrides,
and the plate type all travelled beside the 3MF as resolved profile files and reached the CLI on the
command line. A project preserved without them reopens showing whatever presets it was last SAVED
with and silently drops every override set in the prepare-print dialog — the opposite of the point.

So `slice-settings-authoring.ts` writes them into the project **as a step of the rewrite chain**,
before the engine sees it — upholding the same rule the rest of this document rests on: PrintStream
authors the 3MF, the CLI only slices it. The engine and the preserved copy therefore read one file,
so "slice again" reopens the exact project that produced the print rather than a reconstruction of
it. It reuses the shared pieces "save for a different printer" uses
(`applyProcessProfileToProjectSettings`, `rebindProjectFilamentPhysics`,
`applyFilamentSlotOverrides`) so the two cannot drift on what a setting kind means, and it must run
AFTER the machine step, whose topology maps the process and filament writes index.

**The invariant that makes it safe to run before the engine:** the authored config must describe what
the engine actually did, so authoring cannot change a slice's output. That is MEASURED, not reasoned:
the same project (declaring `sparse_infill_pattern=3dhoneycomb`, `top_shell_layers=4`,
`top_surface_pattern=monotonic` against a custom preset) was sliced twice against a builtin preset,
once with this pass and once without, and both runs produced identical G-code —
`grid/5/monotonicline`, the PRESET's values.

That A/B settled a question worth writing down: **a process preset loaded on the command line
overrides the project's embedded process values outright, so a project's `different_settings_to_system`
deltas are inert once a preset is loaded.** The process step therefore lets the preset win. An earlier
cut of this code restored those deltas, on the theory that the CLI honoured them — it does not, and
restoring them left the kept project declaring changes the print never had (the phantom-changed-
settings failure mode). The FILAMENT step is deliberately the other way round:
`rebindProjectFilamentPhysics` preserves a slot's declared keys, which is right there because a
filament preset binds per slot rather than being loaded wholesale over the project.

Moving authoring ahead of the slice also closed "picked Extra Fine, silently got the project's
0.20mm": the chosen preset's values are written into the project before the engine sees it, so no
later step can fall back to whatever the project happened to carry. (That failure reached users
through the compatibility-fallback retry, which blanked a preset's *identity* via
`sanitizeProjectSettingsConfig` but not its values. The retry itself is gone, see below; authoring
is what makes it unnecessary.)

The mechanics, and why each piece is where it is:

- `slicing-jobs.ts` **stages** a copy into its own temp dir before returning, because `sourcePath`
  lives in a dir the `finally` deletes. It **preserves** only after `persistArtifact` succeeds:
  a `snapshotKey` exempts a row from every age-based sweep, leaving it reclaimable only once nothing
  references it, so writing one for a cancelled or unsaved slice leaks bytes. Which attempt won still
  matters even though the only retry left re-runs UNCHANGED inputs (the crash retry): the preserved
  project must be the bytes the winning attempt handed the engine, never an earlier attempt's.
- Every entry in the chain's `rewrittenSourcePaths` owns its containing directory: the cleanup
  removes the whole dir, so a rewrite step must `mkdtemp` rather than write beside its input.
- `sliced-project-preservation.ts` stores it via `ensureLibrarySnapshotFromLocalPath` — hidden,
  `origin: 'snapshot'`, content-addressed, so slicing the same project repeatedly stores one copy —
  and records `sourceProjectFileId` + `sliceSettingsJson` on the sliced **output**. Not on the
  snapshot: snapshots are shared between any two files with identical bytes and cannot carry
  per-slice facts.
- `library-printing.ts` copies both onto the `PrintJob` at dispatch, so the association survives
  the output being deleted. `library-files.ts` clears them on an overwrite (fresh content, stale
  provenance) and carries them across an `unhideSlicedOutput` merge (the surviving row now holds
  the output's bytes).
- The preserved settings (`preservedSliceSettingsSchema`) are deliberately narrow: engine target,
  preset target, plate, newer-file acknowledgement. Everything else is baked into the project;
  re-sending it would apply it twice. The preset target rides along only so the dialog can seed
  its pickers.
- Process overrides are authored UNDECLARED and filament overrides DECLARED, matching what the
  editor's own two save paths do (`applyGlobalProcessOverrides` vs `applyFilamentSlotOverrides`).
  The asymmetry is pre-existing, not an oversight here: a saved global process override becomes the
  project's baseline, while a material tune stays marked as the user's edit so it keeps a reset.
- **No job, no kept project.** A preserved project only earns its place if the user went on to START
  A PRINT (or deliberately kept the sliced output) — a slice they abandoned must leave nothing behind.
  The write still happens during the slice, because that is the only moment the prepared bytes exist;
  what enforces the rule is that survival is conditional on a reference. Two halves:
  `discardHiddenSlicedOutput` → `discardUnreferencedProjectSnapshot` deletes promptly when the user
  closes the dialog, and `pruneUnreferencedProjectSnapshots` is the backstop for the paths that never
  reach it (closed tab, crashed browser, or the output itself aged out). Both delete only when NOTHING
  references the row, and "nothing" means EVERY relation, not just the project-side ones: a kept output
  (`LibraryFile.sourceProjectFileId`), a job's project link (`PrintJob.sourceProjectFileId`), and a job's
  dispatched artifact (`PrintJob.fileId`). The row is content-addressed, so it is shared between slices
  of identical bytes. Omitting that last relation was not a leak but data loss: `origin`/`snapshotKey`
  do not distinguish a preserved project from a dispatched print's snapshot, so the sweep matched print
  artifacts, and `onDelete: SetNull` then blanked `PrintJob.fileId`, silently costing Reprint on every
  print older than the retention window. Snapshot rows are exempt from every other cleanup pass, so
  without this the leak is permanent.

The web offers it as "Slice again" beside Reprint on both history surfaces (`JobsView`,
`PrinterSummaryCards`), which open `SliceThenPrintFlow` on the preserved project. Because the
project now declares its own presets, the dialog derives the right ones with no seeding — which is
the same rule as everywhere else (see "project presets are the basis").

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

## The public editor

`/3mf-editor` mounts the **same `EditorView`** with no account and no workspace. It is not a fork or
a reduced variant: the difference is entirely in the seams the host supplies (project source, save
target, import store, materials, preset manager, config resolvers), which is why the editor itself
has no "is this public?" flag anywhere.

It is not server-LESS, only workspace-less. The user's FILE never leaves the tab, but the preset
bodies do not live in the tab: the catalogue, the bed mesh, the flush tables, and every preset
resolve come from `/api/public/slicing/*`, and the sidebar stays inert until they arrive
(`slicerDataReady`). "Nothing is uploaded" is the promise; "nothing is fetched" is not.

**Slicing is deliberately not wired.** `LocalEditorSurface` omits `onSlice`, so the footer renders no
slice control at all — a browser can reach neither the printers nor the slicer, and opening public
slicing needs a capacity/abuse answer first (a lowest-priority public lane, per-IP limits, and
fairness against paying workspaces' slices). Everything else — arrange, transform, materials,
process/filament presets and their tune dialogs, per-object overrides, machine retarget on save —
works, as does importing geometry from an STL, a STEP, or another 3MF. Absent by design alongside
slicing: every library affordance — import FROM the library (gated on
`EditorImportStore.supportsLibrarySource`) and export TO it (gated separately, on the save target not
being library-backed, since that is a question about where a save lands rather than what the store
can read).

What the host must answer for itself, and where:

| Capability | Workspace host | Public host |
| --- | --- | --- |
| Project bytes | `GET /api/library/:id/archive` | the user's file, via File System Access where supported, else an `<input type=file>` |
| Save | `POST /api/editor/save` (new library version) | bakes in the tab, writes back to the file (download fallback) |
| Staged imports | uploaded, parsed server-side | parsed in the tab, off the main thread (`importStagingWorker.ts`: STL, the shared 3MF extractor, and the OCCT WASM for STEP) — same formats, no library source |
| Presets | workspace catalogue + custom presets | `/api/public/slicing/*` + the user's browser-stored presets |
| Preset resolution | `/api/slicing/profiles/resolve-*` | `/api/public/slicing/resolve-*`, **builtin ids only** |

Two rules hold the boundary. **The anonymous routes resolve built-in presets and nothing else** — a
`custom:` id is workspace data and is refused at the route, while a `project:` preset is resolved in
the BROWSER from the file's own `project_settings.config`, because the file lives only in that tab.
And **a host advertises only what it can do**: `EditorImportStore.supportsLibrarySource` and
`importableFormats` gate the library entry points and the file picker's `accept`, so the public
editor cannot offer an action that then fails. Both were unconsumed once, and the result was a
"Load from library…" item that opened a picker whose every request 403s.

One accepted limitation: a project built on a workspace CUSTOM preset cannot be diffed against that
preset here (it is unreachable), so the tune dialogs fall back to a weaker baseline. **Which
baseline was used is reported by the RESOLVER** (`SettingsBaselineOrigin` on the
resolve response) rather than re-derived by the host — the dialog renders the matching caveat
through the shared `SettingsBaselineNote`:

| Tier | Baseline | What a marker means |
| --- | --- | --- |
| exact | the preset the project names | what the user assumes; no caveat |
| parent | the standard preset it derives from | a real comparison, against a different preset — an edit whose value equals that standard cannot be flagged |
| partial | a browser-stored preset whose own parent did not resolve | only the keys the preset defines itself are compared |
| declared | nothing resolved | the file's own record of what it changed, not a comparison |

Reporting it from the resolver is the point. Computing it host-side answered per PRESET while the
resolver answers per SLOT, and knew nothing about presets the user had uploaded into their own
browser — so the one tier with a genuinely incomplete baseline was also the one that said nothing.

## Invariants

- **A failed slice is graded on the `--pipe` channel, and retried in exactly two ways.** The engine
  writes its `{"message":…,"total_percent":N}` progress frames ONLY to the `--pipe` FIFO
  (`cli_callback_mgr_t::notify` returns early without one, and `total_percent` appears nowhere else
  in BambuStudio's source); its diagnostics go to stdout/stderr. `classifyCliFailure`
  (`apps/slicer/src/slice-error.ts`) therefore takes those as separate texts, and
  `formatSliceEngineCrashError` must be handed the all-channel one: it decides whether a signal
  death (exit 134-139) was a load/teardown flake worth one retry or a deterministic engine crash to
  name and stop on, and fed console output alone it sees 0% and answers "flake" every time. That
  shipped broken and cost an observed slice a second full run into an identical
  SIGABRT at "Detect overhangs for auto-lift", 66%, with the actionable message never shown. The two
  retries, and there are only two: the API's ONE automatic crash retry with **unchanged** inputs
  (`isTransientSlicerCrashExit`), and the USER's, `POST /api/slicing/jobs/:id/retry`, which re-arms
  the same job id in place. The old third one, which silently dropped the built-in presets the
  engine rejected and reported success on a print nobody configured, is gone and must not come back.
  Where the engine names a cause we report it in ITS terms, not in generic advice
  (`classifyCliFailure`), and the raw log is reachable from the app through `SlicingEngineLog`
  (`apps/web/src/components/`), which fetches `GET /slicing/jobs/:id` because the LIST response
  strips engine output to the last system line. Both exist because a collision whose real cause was
  one model's supports reaching into another reached the user as one wrong sentence, with the line
  that named both models visible only in the container log.
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
  A third specific: the export cannot run with HALF a machine/process pair — with no 3MF loaded,
  a machine preset and no process (the normal state of a project-preset slice that resolved a
  machine file) exits 239 deterministically, as does the mirror case — so
  `ensureMachineProcessPairForExport` derives the missing half from the embedded settings'
  lineage (`print_settings_id` → `inherits_group` → the machine's `default_print_profile`,
  kept only when its `compatible_printers` accepts the loaded machine's SYSTEM name, mirroring
  the CLI's own test) or drops the loaded half so a filaments-only export proceeds. The editor
  makes this path rare in the first place: its SLICE emits the sceneEdit through the same
  `authorFilamentConfigs` pass as its save (`filamentConfigAuthoring.ts`), so a material change
  reaches the slicer with the new preset's physics authored in rather than with the dropped
  arrays that made the config partial.
  When the export itself FAILS (e.g. the CLI's exit 239 "process not compatible with printer"
  from a cross-model machine/process pairing), the guard throws with that reason instead of
  slicing the incomplete config — proceeding is always the deterministic segfault — keeping the
  `Slicer CLI exited with code N` message shape the API's slicing queue classifies (today only
  `isTransientSlicerCrashExit`, for a signal death). The web
  dialog guards the same class at the source: a set-but-incompatible machine/process selection
  (state predating a printer switch) blocks submission with a named reason instead of reaching
  the slicer at all (`printerProfileIncompatible`/`processProfileIncompatible` in
  `SliceFileModal`).
- **`flush_volumes_matrix` is `filaments^2 x extruders`, not `filaments^2` — and `flush_multiplier`
  is one entry per extruder.** BambuStudio stores the matrix as
  one `filaments x filaments` block PER EXTRUDER (`PrintConfig.hpp` `get_flush_volumes_matrix`
  slices block `e`; `BambuStudio.cpp` sizes it `project_filament_count^2 * new_extruder_count`).
  A machine retarget changes the extruder count, so anything that rewrites project settings must
  re-derive both for the NEW topology — `retargetProjectSettingsToMachine` and
  `applyFilamentList` both do, via `repairFlushVolumesMatrix`/`repairFlushMultiplier`
  (`packages/shared/src/flush-volumes-matrix.ts`). Getting this wrong is not a soft failure:
  BambuStudio only repairs an undersized matrix inside its flush-volume recompute block, which it
  SKIPS unless `--filament-colour` was passed, the matrix is absent entirely, the extruder count
  differs from the project's own, or `nozzle_volume_type` mismatches — a retarget satisfies none
  of them, so the short matrix survives and the engine reads the missing block out of bounds:
  a deterministic SIGSEGV at ~71% ("Detect overhangs for auto-lift", CLI exit 139). The multiplier
  half fails later and louder: `GCode.cpp` validates the matrix against
  `filament_colour.size()^2 * flush_multiplier.size()` — the heads count comes from
  `flush_multiplier`, NOT `nozzle_diameter`, and an ABSENT multiplier defaults to ONE entry — so a
  correct matrix beside a stale multiplier fails every multi-filament slice at "Generating G-code"
  with "Flush volumes matrix do not match to the correct size!" (exit 156; the check escapes only
  single-filament projects). The multiplier detection (`isFlushMultiplierInconsistent`) models the
  engine's escapes exactly so working files are never flagged. An ABSENT
  matrix is safe (absence is one of the recompute triggers), so it is deliberately not flagged.
  Projects already saved with the defect are NOT healed at rest — the shared index parser flags
  them (`needsSettingsRepair` on the 3MF index and the `LibraryFile` DTO), the editor shows the
  repair banner on open (staged repair + save), and the print-prep dialog BLOCKS its slice/print
  submit with the advisory pointing at the editor. An editor slice needs no gate: its bake
  re-authors project settings through `applyFilamentList` and is therefore already correct.
- **Purge volumes are editable, and the edit is checked against the material list it lands on.**
  The editor's Materials section opens a flushing-volumes dialog (BambuStudio's "Flushing volumes
  for filament change"): the per-pair grid, the per-extruder multiplier, and a re-calculation.
  It rides `SceneEdit.flushVolumes` — a DEDICATED seam rather than the generic global process
  overrides, because those are applied last, *after* the repair pass, so a mis-sized matrix
  arriving that way would be written verbatim with nothing left to catch it. The bake's
  `applyFlushVolumes` therefore runs AFTER `applyFilamentList` (the user's numbers beat the remap)
  and BEFORE `repairProjectSettingsDocument`, and DROPS a grid whose shape does not match the
  filament set the bake is actually writing — a matrix authored for a different material list
  describes purges between filaments that no longer exist, and forcing it to fit would either
  scramble it or write the exit-139 shape. The multiplier is per-extruder and independent of the
  filament set, so a stale one is conformed instead; which KEY it lands in follows the project's
  `prime_volume_mode` through `flushMultiplierKeyForPrimeVolumeMode`, since BambuStudio's own
  dialog reads and writes `flush_multiplier_fast` in Fast mode.
- **The suggested volumes are a verified port of BambuStudio's calculation, and its measured tables
  are read from the slicer at runtime.** `packages/shared/src/flush-volume-calc.ts` ports
  `FlushVolCalculator` + `WipingDialog::CalcFlushingVolumes`; it was diffed against BambuStudio's
  own compiled code over 69,696 cases (three dataset codes x three dead volumes x an 88-colour
  palette) and matches exactly, including the 32-bit float rounding — computed in double, black to
  white truncates to 559 instead of 560, and that is the most common two-material pairing there is.
  Studio does not trust its own formula where it has measurements: it ships tables of real purge
  volumes (`resources/flush/flush_data_*.txt`) and prefers a table hit within DeltaE2000 5. The gap
  is large (a mean 80 mm3, up to +286, always over-purging), so those tables are served from the
  slicer image (`apps/slicer/src/flush-data.ts` -> `/api/slicing/flush-data` and its public twin)
  rather than vendored — same reasoning as `bed-model.ts`, and it means they track whichever
  BambuStudio actually slices. Their ABSENCE is supported: no slicer, or an engine shipping none,
  falls back to the formula, exactly as Studio does with a missing data file.
  The compiled-in half (the formula's constants, the support floors, the dataset filenames) CANNOT
  be read at runtime, so it is generated by `scripts/dev/generate-flush-volume-model.mjs` from the
  vendored source into `generated/flush-volume-model.generated.ts`; `flush-volume-calc.test.ts`
  re-derives it and fails if BambuStudio retunes anything. Re-run the generator after a vendor bump.
- **The engine is asked for its own answer, because the image and the vendored source drift apart.**
  The generator's test compares against `tmp/bambustudio-src` — but the slicer IMAGE is bumped
  independently of it, so an engine upgrade with no re-vendor moves the numbers with nothing
  failing. The CLI recomputes `flush_volumes_matrix` whenever `--filament-colour` is passed, and
  `--export-settings` runs that path with no model and no slice, so it is a fast probe rather than a
  slice: `apps/slicer/src/flush-calibration.ts` -> `/api/slicing/flush-calibration` (+ its public
  twin) -> `evaluateFlushCalibration`, cached per target. It is a DIAGNOSTIC — it never gates the
  editor, it only decides whether the dialog may claim parity — and a probe that cannot run reads as
  "unchecked", never as "agrees".
  It has already earned it: it caught `readProjectFlushContext` reading a variant-wide machine array
  POSITIONALLY. On a machine with extruder variants (H2D) `nozzle_flush_dataset` and `nozzle_volume`
  are indexed by (extruder x variant) — five entries for two extruders — and BambuStudio resolves an
  extruder's row by matching `<extruder_type> <nozzle_volume_type>` against
  `printer_extruder_variant` with `printer_extruder_id` (`get_index_for_extruder`). Positional
  indexing is right for extruder 0 and wrong for extruder 1, so only the SECOND nozzle was
  mis-priced — invisible to 69,696 calculator tests, because the calculator was never the problem.
  The probe also settled two places the engine and its own GUI disagree, both resolved in the
  ENGINE's favour since it is what purges: the variant lookup above (its dialog indexes
  positionally), and `get_min_flush_volumes(config, 0)` being hoisted out of the CLI's per-extruder
  loop, so every extruder uses extruder 0's dead volume.
- **An object's material must be written at OBJECT level in `model_settings.config`, not only on
  its `<part>`.** For an INLINE-MESH object (one part reusing the object's own id — the shape the
  bake used to write for replaced/imported objects) the CLI does not honor the part-level
  `extruder`, so the object silently prints with **filament 1** whatever its parts say — A/B-proven
  on a real project (plate objects assigned material 2 sliced as PLA until the object entry was
  added, then as PETG). In the COMPONENTS layout the CLI binds part-level entries fine (measured:
  a mixed-material components object with no object entry sliced each part correctly). Desktop
  BambuStudio writes the extruder at both levels, and the bake now does too (the imported-object
  writers in `bake-documents.ts`, and `applyPartFilamentOverrides` keeps the object entry in step
  whenever a reassignment leaves every filament-carrying part on one slot). Files saved before
  this carry the part-only shape; `repairs/object-extruder.ts` detects them (`objectExtruder`
  reason) and the staged repair adds the missing entry at save time. Parts DISAGREEING is still derivable when
  every carrying part has its own entry — more than one part means components layout (3MF objects
  are mesh XOR components), each volume overrides the object slot, so the first part's value is
  engine-inert and merely restores the BambuStudio shape. The one genuinely ambiguous case is
  MIXED coverage (a carrying part with no entry inherits the object slot): those objects are
  reported by name, never written — giving their uncovered parts a material in the editor lets the
  next repair derive cleanly.
- **ONE repair model: repairs happen in the editor, staged and undoable.** Wherever an editor is
  open — workspace or public — the notice's Repair pins `settingsRepairStaged` in the editor state
  as an undoable edit (`SceneEdit.repairSettings`), and the bake applies the shared `repairs/`
  implementations as its LAST project_settings / model_settings step — authoring always wins
  first, every repair is inspect-gated, and a healthy document rides through untouched. Nothing is
  written until the user saves, and undo restores the banner. There is NO instant server-side
  repair: a surface with no editor session (the print-prep dialog) blocks its submit on
  `needsSettingsRepair` and its advisory points at the editor, because a flagged file is repaired
  deliberately, never printed through slice-time fix-ups the user never sees. An archived version
  stays advisory everywhere: repairing it means restoring it first, a decision the user makes
  knowingly.
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
- **Shared 3MF index + scene parsers.** Both pure parses are produced by one shared module,
  `@printstream/shared/three-mf` (`index-parser.ts`, `scene-parser.ts`). The index parse is
  consumed by `apps/api/src/lib/three-mf-reader.ts` and `apps/bridge/src/library-3mf.ts`; the
  scene parse by that same reader and by the web's public 3MF editor (`/3mf-editor`), which
  unzips the user's file in the browser and never uploads it. Changing the index shape means editing that parser
  once, updating the shared schema, and bumping `THREE_MF_INDEX_PARSER_VERSION` — see
  the API development notes and the bridge development notes. Keep both parsers Node-free; each app
  owns its own ZIP I/O and caching. (All 3MF *writing* — `three-mf-scene-builder.ts`,
  `three-mf-output.ts` — still lives only in the api modules.)
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
- **A project snapshot is only written for a slice whose output was persisted.** Snapshot rows are
  exempt from every cleanup pass, so one written for a cancelled, failed, or discarded slice is
  bytes nothing will ever reference or reclaim. Stage the copy early (the prepared project's temp
  dir is deleted the moment the slice returns), preserve it late.
- The editor reflects new state through scene re-render, not optimistic UI guesses.

## Known god files / target decomposition (roadmap)

These predate the two-feature framing; split them incrementally toward it (each split is its
own verified change — do not big-bang):

- **Done:** `apps/api/src/lib/three-mf.ts` (~3.7k lines) split into `three-mf-internal.ts`
  (shared ZIP I/O + abort/escape helpers + `rewriteModelSettingsThreeMf`), `three-mf-reader.ts`
  (read/index/scene parse — both halves now delegate to the shared `@printstream/shared/three-mf`
  parsers, leaving ZIP I/O + caching here), `three-mf-scene-builder.ts` (editor:
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
