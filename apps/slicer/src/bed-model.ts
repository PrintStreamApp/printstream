/**
 * Resolves a printer model's 3D bed mesh from the bundled BambuStudio resources.
 *
 * The editor can render the real build plate (BambuStudio's look) instead of the plain
 * millimetre grid. The meshes ship inside the slicer image as part of BambuStudio's
 * resources — where they already sit under the engine's AGPL attribution and
 * corresponding-source offer (`apps/slicer/THIRD-PARTY-SLICERS.md`) — so this serves them
 * from there rather than copying them into the web bundle or the public OSS snapshot.
 *
 * Lookup: `resources/profiles/BBL/machine/<printer model>.json` carries `bed_model`
 * (e.g. `bbl-3dp-H2D.stl`), and the mesh itself sits beside it in `resources/profiles/BBL/`.
 * Callers may pass either BambuStudio's model name (`Bambu Lab H2D`) or our canonical model key
 * (`H2D` — what the editor actually has on hand), so an exact filename miss falls back to
 * matching each model profile's canonicalised name.
 * NOTE the flattened `machine_full/` catalogue the slice path uses does NOT carry these keys —
 * they live only on the model-level profile — hence reading the raw profile tree here.
 *
 * Counterpart: the API proxies this to the browser (`/api/slicing/bed-model`), which parses
 * the STL and renders it; see `apps/web/src/plugins/model-studio/lib/bedModel.ts`.
 */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { canonicalBambuModelKey } from '@printstream/shared'

/** BambuStudio's vendor profile root, relative to a target's AppDir. */
const BBL_PROFILE_DIR = ['resources', 'profiles', 'BBL']

/**
 * Bed meshes are addressed by a filename that comes out of a JSON profile, so it is treated as
 * untrusted: only a bare `.stl` basename is ever joined onto the resource directory. Anything
 * with a separator or traversal segment is rejected rather than sanitised.
 */
const SAFE_BED_MODEL_NAME = /^[A-Za-z0-9._-]+\.stl$/

export interface BedModelResult {
  /** The resolved mesh file name, e.g. `bbl-3dp-H2D.stl`. */
  fileName: string
  bytes: Buffer
}

/**
 * The bed mesh for `printerModel` (a BambuStudio printer-model name such as `Bambu Lab H2D`),
 * or null when the target ships no such model, the profile names no bed, or the file is absent.
 * Never throws for a missing/!unreadable profile — a bed render is decoration, so the caller
 * falls back to the plain grid rather than failing the editor.
 */
export async function readBedModel(appDir: string | null | undefined, printerModel: string): Promise<BedModelResult | null> {
  const model = printerModel.trim()
  if (!appDir || !model) return null
  // The model name reaches the filesystem, so it gets the same treatment as the bed filename.
  if (model.includes('/') || model.includes('\\') || model.includes('..')) return null

  const profileRoot = path.join(appDir, ...BBL_PROFILE_DIR)
  const machineDir = path.join(profileRoot, 'machine')

  // Candidates, best first: the exact filename, then — for a canonical key like `H2D` — every
  // profile whose name maps to the same model, SHORTEST FIRST. The ordering matters: that
  // directory holds nozzle variants and gcode templates ("Bambu Lab H2D 0.4 nozzle.json",
  // "… template layer_change_gcode.json") alongside the model-level profile, and only the
  // model-level one ("Bambu Lab H2D.json") declares `bed_model`.
  const candidates = [`${model}.json`]
  const wanted = canonicalBambuModelKey(model)
  if (wanted) {
    const entries = await readdir(machineDir).catch(() => [] as string[])
    candidates.push(...entries
      .filter((entry) => entry.endsWith('.json')
        && entry !== `${model}.json`
        && canonicalBambuModelKey(entry.slice(0, -'.json'.length)) === wanted)
      .sort((a, b) => a.length - b.length))
  }

  // Take the first candidate that actually declares a usable bed mesh, rather than trusting the
  // name alone — a variant profile matching the model would otherwise dead-end at "no bed".
  let bedModelName: string | null = null
  for (const candidate of candidates) {
    const raw = await readFile(path.join(machineDir, candidate), 'utf8').catch(() => null)
    if (!raw) continue
    let declared: unknown
    try {
      declared = (JSON.parse(raw) as Record<string, unknown>).bed_model
    } catch {
      continue
    }
    if (typeof declared === 'string' && SAFE_BED_MODEL_NAME.test(declared)) {
      bedModelName = declared
      break
    }
  }
  if (!bedModelName) return null

  const bytes = await readFile(path.join(profileRoot, bedModelName)).catch(() => null)
  return bytes ? { fileName: bedModelName, bytes } : null
}
