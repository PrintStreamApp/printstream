/**
 * Ensure a to-be-sliced 3MF carries a structurally complete `Metadata/project_settings.config`.
 *
 * A "from scratch" project 3MF (PrintStream's calibration scaffolds and new-project saves, built
 * by `buildEditedThreeMf(null, …)`) carries the `Application: BambuStudio-…` marker so the CLI
 * takes its BBL-project path, which is required to slice per-plate and keep the injected
 * `custom_gcode_per_layer.xml` (without the marker the CLI logs "not support to slice plate N,
 * reset to 0" and drops the per-layer G-code). But that BBL-project loader dereferences the
 * project's embedded `project_settings.config`, and a scaffold 3MF has none, so the CLI
 * segfaults (SIGSEGV / exit 139) at load, before it reads the model.
 *
 * A hand-merge of the machine/process/filament presets does NOT satisfy the loader (it fills ~150
 * defaulted keys the presets omit). So we let BambuStudio itself produce a genuine merged config
 * via a fast `--export-settings` pass over the very `--load-settings`/`--load-filaments` the slice
 * will use, then embed that as the 3MF's `project_settings.config`. The slice's own
 * `--load-settings` still overrides these values (3mf-embedded settings are lowest priority), so
 * the embedded config only needs to be structurally complete, which a genuine export is.
 *
 * A scaffold save can embed a PARTIAL config (the editor's chosen filaments / plate type /
 * retargeted machine: see the API's `buildEditedThreeMf` + `retargetSavedProjectMachine`), which
 * is just as unsafe for the loader as no config. Those are detected by
 * {@link hasCompleteEmbeddedProjectSettings} (cross-domain sentinel keys) and repaired the same
 * way, with the partial values overlaid onto the genuine export so the user's choices
 * (`curr_bed_type`, filament colours, machine identity) still win. This matters MOST for a
 * project-preset slice (`project:process:…`), which loads no external profiles at all: the CLI
 * then reads the embedded settings bare and a partial config segfaults it deterministically at
 * load; the export args for that case are derived from the preset names the settings themselves
 * carry, resolved against the slicer's builtin catalog.
 *
 * MATERIAL CHANGE. The editor's save path (the API's `applyFilamentList`) deliberately DROPS the
 * old material's per-filament physics, including the `nozzle_temperature` completeness sentinel,
 * whenever a slot's material changes (e.g. ABS -> PETG), so the saved config lands here INCOMPLETE
 * on purpose. This module then re-derives that slot's physics from the preset names the settings
 * still carry (`ensureFilamentCoverage` -> `buildFilamentCoverageFromEmbedded`), so the new
 * material slices with its own temperatures/flow rather than the old material's cloned values.
 *
 * A no-op when the 3MF already embeds a complete `project_settings.config` (every real
 * BambuStudio project, and any save with no material change), so normal slicing is untouched.
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { access, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import yazl from 'yazl'
import { type Entry } from 'yauzl'
import { machinePresetSlotIndexFor } from '@printstream/shared'
import { sanitizeProfileFileName } from './profile-file-name.js'
import { openZip, readZipEntryBuffer, readZipEntryText } from './zip-io.js'

const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'

/**
 * One sentinel key per settings domain. A genuine BambuStudio/OrcaSlicer project (or an
 * `--export-settings` merge) serializes its FULL config and always carries all three; the partial
 * configs our save path can embed (filament colours + plate type, optionally machine/process keys
 * from a retarget but never the full defaulted filament arrays) always miss at least one.
 */
export const COMPLETE_SETTINGS_SENTINEL_KEYS = ['printable_area', 'layer_height', 'nozzle_temperature'] as const

/** The embedded `project_settings.config` as a parsed record, or null when absent/unreadable. */
async function readEmbeddedProjectSettings(inputPath: string): Promise<Record<string, unknown> | null> {
  const text = await readZipEntryText(inputPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  if (typeof text !== 'string' || text.trim().length === 0) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Whether the 3MF already embeds a `project_settings.config` (any real BambuStudio project does). */
export async function hasEmbeddedProjectSettings(inputPath: string): Promise<boolean> {
  const text = await readZipEntryText(inputPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  return typeof text === 'string' && text.trim().length > 0
}

/**
 * Whether the 3MF embeds a structurally COMPLETE `project_settings.config`, one safe for the
 * CLI's BBL-project loader (see the module header). Exposed for tests.
 */
export async function hasCompleteEmbeddedProjectSettings(inputPath: string): Promise<boolean> {
  const settings = await readEmbeddedProjectSettings(inputPath)
  return settings !== null && COMPLETE_SETTINGS_SENTINEL_KEYS.every((key) => settings[key] !== undefined)
}

function firstStringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const first = value.find((entry) => typeof entry === 'string' && entry.trim())
    return typeof first === 'string' ? first.trim() : null
  }
  return null
}

/**
 * The preset names an embedded config claims, for an error message that tells the user WHICH
 * presets could not be resolved (typically a project-only custom process such as
 * "0.24mm Standard @BBL H2D - Ryan" that exists nowhere but inside the 3MF). Returns null when
 * the config names nothing at all.
 */
function describeEmbeddedPresetNames(embedded: Record<string, unknown>): string | null {
  const parts: string[] = []
  const machine = firstStringValue(embedded.printer_settings_id)
  const process = firstStringValue(embedded.print_settings_id)
  const filament = firstStringValue(embedded.filament_settings_id)
  if (machine) parts.push(`printer "${machine}"`)
  if (process) parts.push(`process "${process}"`)
  if (filament) parts.push(`filament "${filament}"`)
  return parts.length > 0 ? `it names ${parts.join(', ')}` : null
}

async function builtinProfilePathForName(profileDir: string, kind: 'machine' | 'process' | 'filament', name: string | null): Promise<string | null> {
  if (!name) return null
  const filePath = path.join(profileDir, `${kind}_full`, `${sanitizeProfileFileName(name)}.json`)
  return access(filePath).then(() => filePath, () => null)
}

/**
 * Build `--load-settings`/`--load-filaments` args for the settings export by resolving the
 * preset NAMES the embedded settings themselves carry (`printer_settings_id`,
 * `print_settings_id`, `filament_settings_id`) against the slicer's flattened builtin profile
 * catalog. This is what lets a PROJECT-PRESET slice, which deliberately loads no external
 * profiles (the embedded settings are the preset), still synthesize a complete config when the
 * embedded settings turn out to be partial. Null when nothing resolves (e.g. custom presets),
 * in which case the caller slices as-is.
 */
async function buildExportArgsFromEmbeddedPresetNames(
  embedded: Record<string, unknown>,
  profileDir: string
): Promise<string[] | null> {
  const machinePath = await builtinProfilePathForName(profileDir, 'machine', firstStringValue(embedded.printer_settings_id))
  const processPath = await builtinProfilePathForName(profileDir, 'process', firstStringValue(embedded.print_settings_id))
  // Slot COUNT is load-bearing, so resolve filaments through the padding helper rather than
  // dropping the names that miss. This used to filter unresolved slots out, emitting a
  // `--load-filaments` list SHORTER than the project's filament count: BambuStudio then reads
  // its per-filament vectors out of bounds and segfaults while loading (opaque exit 139, the
  // same out-of-bounds shape as the `filament_map` crash in issue #63). A 3MF whose
  // `filament_settings_id` holds an unresolvable DISPLAY name ("Bambu PETG Basic" instead of
  // "Bambu PETG Basic @BBL H2D 0.4 nozzle") is exactly the case that triggers it.
  const filamentCoverage = await buildFilamentCoverageFromEmbedded(embedded, profileDir)

  const settingsPaths = [machinePath, processPath].filter((entry): entry is string => entry !== null)
  // The export needs at least the machine or process preset to be meaningful; filaments alone
  // don't anchor a printable config.
  if (settingsPaths.length === 0) return null
  const args = ['--load-settings', settingsPaths.join(';')]
  if (filamentCoverage) args.push('--load-filaments', filamentCoverage)
  return args
}

/**
 * A `--load-filaments` value (`;`-joined paths) covering every slot the embedded settings name:
 * each `filament_settings_id` entry resolves to its builtin preset, or Generic PLA when it does
 * not, so the export keeps the project's slot COUNT and gives each slot its own material. Null
 * when the settings name no filaments. This is what makes a material-changed project (whose editor
 * save DROPPED the old material's physics: see the API's `applyFilamentList`) re-derive the NEW
 * material's temperatures/flow instead of collapsing to a single Generic PLA baseline.
 *
 * **Invariant: the returned list covers EVERY named slot or is null, never a short list.**
 * BambuStudio sizes its per-filament vectors from the loaded filament count and indexes them by
 * the project's slot ids, so a list shorter than the project's filament count reads out of bounds
 * and segfaults the loader (exit 139). Returning null instead leaves the caller to slice without
 * the export, which fails with a message rather than a crash.
 */
async function buildFilamentCoverageFromEmbedded(
  embedded: Record<string, unknown> | null,
  profileDir: string
): Promise<string | null> {
  const rawNames = embedded && Array.isArray(embedded.filament_settings_id) ? embedded.filament_settings_id : []
  const names = rawNames.filter((entry): entry is string => typeof entry === 'string')
  if (names.length === 0) return null
  const genericPla = await builtinProfilePathForName(profileDir, 'filament', 'Generic PLA')
  const paths: string[] = []
  for (const name of names) {
    const resolved = name.trim() ? await builtinProfilePathForName(profileDir, 'filament', name) : null
    const covered = resolved ?? genericPla
    // No preset AND no Generic PLA to pad with (a broken profile dir): a partial list would
    // crash the loader, so abandon the coverage entirely rather than under-fill it.
    if (!covered) return null
    paths.push(covered)
  }
  return paths.join(';')
}

/** `inherits_group` is positional: `[process, filament1..N, machine]` (what the API's sanitize and
 * BambuStudio's own writer both assume). The PROCESS lineage is entry 0; the MACHINE lineage sits at
 * `filament_count + 1`, which is where the ENGINE reads it (`PresetBundle.cpp:3885`).
 *
 * Not the array's LAST entry, which is the same answer only while the array is correctly sized. A
 * mis-sized `inherits_group` is a defect the repair stage exists for and therefore a shape this
 * meets in the wild, and there the last entry is a stale leftover: deriving the machine preset name
 * from it hands the settings export a printer the project does not use, which fails every process
 * as incompatible (exit 239) and silently completes the slice on the wrong presets. */
function processInheritsFromGroup(embedded: Record<string, unknown> | null): string | null {
  const group = embedded && Array.isArray(embedded.inherits_group) ? embedded.inherits_group : []
  return group.length >= 2 ? firstStringValue(group[0]) : null
}
function machineInheritsFromGroup(embedded: Record<string, unknown> | null): string | null {
  if (!embedded || !Array.isArray(embedded.inherits_group)) return null
  const group = embedded.inherits_group
  const machineIndex = machinePresetSlotIndexFor(embedded)
  // Past the end, or not locatable at all: no machine lineage is stated. Say nothing rather than
  // reach for whatever entry happens to be there.
  if (machineIndex == null || machineIndex < 1 || machineIndex >= group.length) return null
  return firstStringValue(group[machineIndex])
}

/** Trimmed string entries of a `compatible_printers`-style value; [] for anything else. */
function stringListValue(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0).map((entry) => entry.trim())
}

/**
 * The name the CLI tests process compatibility against for a loaded machine preset: its own name
 * for a system preset, its `inherits` (the system base) for a User preset: mirroring
 * `load_config_file` in BambuStudio's CLI (`config_from == "system" ? name : inherits`).
 */
function machineSystemName(machine: Record<string, unknown>): string | null {
  const from = typeof machine.from === 'string' ? machine.from.trim().toLowerCase() : ''
  return from === 'system' ? firstStringValue(machine.name) : firstStringValue(machine.inherits)
}

/** The `--load-settings` files of an export arg set, classified by their own `type` field. */
interface LoadSettingsClassification {
  /** Index of the `--load-settings` flag in the args. */
  index: number
  /** The `;`-joined value split back into file paths. */
  paths: string[]
  machine: Record<string, unknown> | null
  process: Record<string, unknown> | null
  /** True when any file could not be read/parsed/classified: leave such args alone. */
  unknown: boolean
}

async function classifyLoadSettings(args: readonly string[]): Promise<LoadSettingsClassification | null> {
  const index = args.indexOf('--load-settings')
  const value = index >= 0 ? args[index + 1] : undefined
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const paths = value.split(';').filter((entry) => entry.trim().length > 0)
  const classification: LoadSettingsClassification = { index, paths, machine: null, process: null, unknown: false }
  for (const filePath of paths) {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>
      if (parsed.type === 'machine') classification.machine = parsed
      else if (parsed.type === 'process') classification.process = parsed
      else classification.unknown = true
    } catch {
      classification.unknown = true
    }
  }
  return classification
}

/** `args` with `extraPath` appended to the `--load-settings` value. */
function withExtraLoadSettingsPath(args: readonly string[], loaded: LoadSettingsClassification, extraPath: string): readonly string[] {
  const next = [...args]
  next[loaded.index + 1] = [...loaded.paths, extraPath].join(';')
  return next
}

/** `args` without its `--load-settings` flag + value. */
function withoutLoadSettings(args: readonly string[], loaded: LoadSettingsClassification): readonly string[] {
  return args.filter((_entry, index) => index !== loaded.index && index !== loaded.index + 1)
}

/**
 * The export cannot run with HALF a machine/process pair. `--export-settings` loads no 3MF, so
 * with a machine loaded and no process the CLI tests the (absent) project's
 * `print_compatible_printers`, an empty list, whose "compatible with everything" carve-out only
 * applies when no new printer was loaded, and exits 239 "process not compatible with printer";
 * a process with no machine fails the same test from the other side (both verified against the
 * 2.7.1 CLI, and mirrored in `BambuStudio.cpp`'s exit-239 block). The slice itself is fine with
 * either half: the rewritten 3MF carries the other. Only this export needs the pairing.
 *
 * So when the args carry exactly one half, derive the other from names the inputs already declare,
 * preferring the embedded settings' own lineage so the baseline stays close to what the slice will
 * actually use, keeping only a candidate whose `compatible_printers` pairing the CLI will accept
 * (same containment test, against the machine's SYSTEM name). When nothing resolvable is
 * compatible, drop the loaded half instead: a filaments-only export succeeds (the no-presets
 * branch of the CLI's check treats an empty list as compatible), and the export is only a
 * structural baseline the embedded settings overlay anyway. Args whose `--load-settings` files
 * cannot be classified are returned untouched, never meddle where the pairing cannot be seen.
 */
async function ensureMachineProcessPairForExport(
  args: readonly string[],
  profileDir: string | null | undefined,
  embedded: Record<string, unknown> | null,
  log: (message: string) => void
): Promise<readonly string[]> {
  const loaded = await classifyLoadSettings(args)
  if (!loaded || loaded.unknown) return args
  if ((loaded.machine !== null) === (loaded.process !== null)) return args

  if (loaded.machine) {
    const systemName = machineSystemName(loaded.machine)
    const candidates = [
      firstStringValue(embedded?.print_settings_id),
      processInheritsFromGroup(embedded),
      firstStringValue(loaded.machine.default_print_profile),
      firstStringValue(embedded?.default_print_profile)
    ]
    for (const name of candidates) {
      if (!profileDir || !name) continue
      const processPath = await builtinProfilePathForName(profileDir, 'process', name)
      if (!processPath) continue
      const config = await readFile(processPath, 'utf8').then((raw) => JSON.parse(raw) as Record<string, unknown>).catch(() => null)
      if (!config || !systemName || !stringListValue(config.compatible_printers).includes(systemName)) continue
      log(`Settings export: pairing the machine with process "${name}" (a machine preset cannot export without one)`)
      return withExtraLoadSettingsPath(args, loaded, processPath)
    }
    log('Settings export: no compatible process preset resolves: exporting without the machine preset')
    return withoutLoadSettings(args, loaded)
  }

  const process = loaded.process as Record<string, unknown>
  const compatiblePrinters = stringListValue(process.compatible_printers)
  const candidates = [
    firstStringValue(embedded?.printer_settings_id),
    machineInheritsFromGroup(embedded),
    ...compatiblePrinters
  ]
  for (const name of candidates) {
    if (!profileDir || !name) continue
    const machinePath = await builtinProfilePathForName(profileDir, 'machine', name)
    if (!machinePath) continue
    const config = await readFile(machinePath, 'utf8').then((raw) => JSON.parse(raw) as Record<string, unknown>).catch(() => null)
    const systemName = config ? machineSystemName(config) : null
    if (!systemName || !compatiblePrinters.includes(systemName)) continue
    log(`Settings export: pairing the process with machine "${name}" (a process preset cannot export without one)`)
    return withExtraLoadSettingsPath(args, loaded, machinePath)
  }
  log('Settings export: no compatible machine preset resolves: exporting without the process preset')
  return withoutLoadSettings(args, loaded)
}

/**
 * The export must cover the FILAMENT domain too: with no filament preset loaded, the exported
 * config omits the nullable per-filament override arrays (`filament_retraction_length`,
 * `filament_z_hop_types`, …) and the bare BBL-project loader still segfaults on the merge:
 * verified against the 2.7.1 CLI. When the args carry no `--load-filaments` (the project's
 * filament names didn't resolve, or the slice loads only a process), cover the filament domain
 * from the presets the embedded settings NAME (so a material-changed project slices with the new
 * material's real physics), padding unresolved slots with Generic PLA; fall back to a single
 * Generic PLA when the settings name no filaments. The export is only a structural baseline: the
 * project's own values are overlaid on top.
 */
async function ensureFilamentCoverage(
  args: readonly string[],
  profileDir: string | null | undefined,
  embedded: Record<string, unknown> | null
): Promise<readonly string[]> {
  if (args.includes('--load-filaments') || !profileDir) return args
  const fromEmbedded = await buildFilamentCoverageFromEmbedded(embedded, profileDir)
  if (fromEmbedded) return [...args, '--load-filaments', fromEmbedded]
  const fallback = await builtinProfilePathForName(profileDir, 'filament', 'Generic PLA')
  return fallback ? [...args, '--load-filaments', fallback] : args
}

interface ExportMergedProjectSettingsResult {
  settings: string | null
  /** Non-zero (or null on spawn/signal death) CLI exit when the export failed; 0 on success. */
  exitCode: number | null
  /**
   * Most specific reason the CLI gave for a failed export: the last `[error]` log line's text
   * (BambuStudio reports these on STDOUT, e.g. "process not compatible with printer"), falling
   * back to the last non-empty output line. Null on success or when nothing was captured.
   */
  failureDetail: string | null
}

/** Extract the most actionable line from a failed export's combined CLI output. */
function extractCliFailureDetail(output: string): string | null {
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] as string
    const errorMatch = /\[error\]\s+(?:\S+\s+\d+:\s*)?(.+)$/.exec(line)
    if (errorMatch?.[1]) return errorMatch[1].trim()
  }
  return lines.at(-1) ?? null
}

/** Run the CLI with the given profile args + `--export-settings` and return the exported JSON, or a failure. */
async function exportMergedProjectSettings(input: {
  cliPath: string
  appDir: string | null
  profileArgs: readonly string[]
  workDir: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}): Promise<ExportMergedProjectSettingsResult> {
  // `--export-settings` writes the fully merged `--load-settings`/`--load-filaments` config; it
  // needs no input model and does not slice, so it is fast. Absolute output path (no `--outputdir`).
  const settingsPath = path.join(input.workDir, `project-settings-${randomUUID()}.config`)
  const args = [...input.profileArgs, '--export-settings', settingsPath]
  let combinedOutput = ''
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(input.cliPath, args, {
      // BambuStudio logs its errors (boost log `[error]` lines) to STDOUT, so both streams must
      // be captured, with stdout ignored, a compatibility failure here is undiagnosable.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...input.env, SLICER_APPDIR: input.appDir ?? input.env.SLICER_APPDIR }
    })
    const capture = (chunk: string) => { combinedOutput = (combinedOutput + chunk).slice(-4000) }
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', capture)
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', capture)
    const onAbort = () => { try { child.kill('SIGKILL') } catch { /* already gone */ } }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => { input.signal?.removeEventListener('abort', onAbort); reject(error) })
    child.on('close', (code) => { input.signal?.removeEventListener('abort', onAbort); resolve(code) })
  })
  if (exitCode !== 0) {
    await rm(settingsPath, { force: true }).catch(() => undefined)
    return { settings: null, exitCode, failureDetail: extractCliFailureDetail(combinedOutput) }
  }
  const content = await readFile(settingsPath, 'utf8').catch(() => null)
  await rm(settingsPath, { force: true }).catch(() => undefined)
  return content && content.trim().length > 0
    ? { settings: content, exitCode: 0, failureDetail: null }
    : { settings: null, exitCode: 0, failureDetail: 'export produced no settings output' }
}

/** Copy every entry of `inputPath` into `outputPath`, adding (or replacing) `project_settings.config`. */
export async function copyThreeMfWithProjectSettings(inputPath: string, outputPath: string, projectSettings: string): Promise<void> {
  const sourceZip = await openZip(inputPath)
  const outputZip = new yazl.ZipFile()
  const output = createWriteStream(outputPath)
  outputZip.outputStream.pipe(output)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error) => {
      if (settled) return
      settled = true
      sourceZip.close()
      if (error) { output.destroy(); reject(error) } else { resolve() }
    }
    outputZip.outputStream.on('error', finish)
    output.on('error', finish)
    output.on('close', () => finish())
    sourceZip.on('error', finish)
    sourceZip.on('end', () => {
      outputZip.addBuffer(Buffer.from(projectSettings, 'utf8'), PROJECT_SETTINGS_ENTRY)
      outputZip.end()
    })
    sourceZip.on('entry', (entry: Entry) => {
      if (/\/$/.test(entry.fileName)) {
        outputZip.addEmptyDirectory(entry.fileName, { mtime: entry.getLastModDate() })
        sourceZip.readEntry()
        return
      }
      // Skip any existing project_settings entry; we add our own after all entries.
      if (entry.fileName === PROJECT_SETTINGS_ENTRY) { sourceZip.readEntry(); return }
      readZipEntryBuffer(sourceZip, entry).then(
        (buffer) => { outputZip.addBuffer(buffer, entry.fileName, { mtime: entry.getLastModDate() }); sourceZip.readEntry() },
        finish
      )
    })
    sourceZip.readEntry()
  })
}

/**
 * If `inputPath` lacks a structurally complete `project_settings.config`, synthesize one from the
 * slice's own profile args (via {@link exportMergedProjectSettings}), overlay whatever partial
 * settings the 3MF DID embed (so the project's `curr_bed_type`, filament colours, and retargeted
 * machine identity win over the export's values), and return the path to a rewritten 3MF that
 * embeds the merge. Returns `inputPath` unchanged when it already embeds a complete config, or
 * when there is nothing to synthesize from (no load args and no resolvable preset names).
 *
 * Failure semantics: when the settings export RUNS and fails, this THROWS with the CLI's exit
 * code and reason instead of letting the slice proceed, a partial/absent config reaching the
 * BBL-project loader is a deterministic segfault, so "slicing as-is" could only ever trade a
 * clear error (e.g. "process not compatible with printer") for an opaque exit 139. The thrown
 * message keeps the `Slicer CLI exited with code N` shape the API's crash classifier keys on
 * (`isTransientSlicerCrashExit` in the API's slicing-jobs), so a transient signal death still gets
 * its one retry with unchanged inputs.
 */
export async function ensureEmbeddedProjectSettings(input: {
  inputPath: string
  cliPath: string
  appDir: string | null
  profileArgs: readonly string[]
  /** The slicer target's flattened builtin profile catalog (machine_full/ etc.), when available. */
  profileDir?: string | null
  workDir: string
  env: NodeJS.ProcessEnv
  log: (message: string) => void
  signal?: AbortSignal
}): Promise<string> {
  const embedded = await readEmbeddedProjectSettings(input.inputPath)
  const missingSentinels = embedded === null
    ? [...COMPLETE_SETTINGS_SENTINEL_KEYS]
    : COMPLETE_SETTINGS_SENTINEL_KEYS.filter((key) => embedded[key] === undefined)
  if (embedded !== null && missingSentinels.length === 0) {
    return input.inputPath
  }

  // Args the settings export runs with. Normally the slice's own profile args; a PROJECT-PRESET
  // slice loads none (the embedded settings ARE the preset), so derive them from the preset names
  // the embedded settings carry: the case that used to be skipped outright and let a partial
  // config reach the loader bare (deterministic SIGSEGV at "Start to load files").
  let exportArgs: readonly string[] = input.profileArgs
  const hasLoadSettings = exportArgs.includes('--load-settings') || exportArgs.includes('--load-filaments')
  if (!hasLoadSettings) {
    const derived = embedded !== null && input.profileDir
      ? await buildExportArgsFromEmbeddedPresetNames(embedded, input.profileDir)
      : null
    if (!derived) {
      // Reaching here means the embedded config FAILED the completeness check above and nothing
      // can repair it: no `--load-*` args, and none of the preset names it carries resolve. That
      // is deterministically fatal, the BBL-project loader segfaults on a partial config at
      // "Start to load files", so fail with what is actually wrong instead of slicing into an
      // opaque exit 139 (and, because the crash classifier then retries, doing it three times).
      //
      // Deliberately NOT shaped like `Slicer CLI exited with code N`: this is not recoverable by
      // retrying, so it must not match the API's crash classifier (`isTransientSlicerCrashExit` in
      // slicing-jobs) the way the export-failure branch deliberately does.
      if (embedded !== null) {
        const named = describeEmbeddedPresetNames(embedded)
        throw new Error(
          `This project's embedded settings are incomplete (missing ${missingSentinels.join(', ')}) and name no presets this slicer can resolve${named ? ` (${named})` : ''}. `
          + 'Pick a process and filament profile for the slice, or re-save the project so it embeds complete settings.'
        )
      }
      return input.inputPath
    }
    exportArgs = derived
  }
  // Order matters: the pairing may DROP `--load-settings` entirely, and the filament coverage
  // below is what keeps such an export meaningful (a filaments-only export succeeds).
  exportArgs = await ensureMachineProcessPairForExport(exportArgs, input.profileDir, embedded, input.log)
  exportArgs = await ensureFilamentCoverage(exportArgs, input.profileDir, embedded)

  // Name the keys and the arg count. This step REPLACES the project's settings with the CLI's
  // merged export, so when the slice then dies at load, the first question is what made a project
  // look partial at all, and a bare "completing partial settings" cannot answer it. A real
  // incident (a project whose STORED settings were complete, yet reached here) could not be
  // diagnosed from the logs because the missing key was never recorded.
  input.log(embedded === null
    ? 'Synthesizing project settings for scaffold 3MF (no embedded project_settings.config)'
    : `Completing partial embedded project settings for scaffold 3MF (missing ${missingSentinels.join(', ')}; ${exportArgs.length} profile args)`)
  const exported = await exportMergedProjectSettings({
    cliPath: input.cliPath,
    appDir: input.appDir,
    profileArgs: exportArgs,
    workDir: input.workDir,
    env: input.env,
    signal: input.signal
  })
  const projectSettings = exported.settings
  if (!projectSettings) {
    // Slicing on anyway is never viable from here: this path only runs when the embedded config
    // is absent or partial, and the BBL-project loader deterministically segfaults on both (an
    // opaque exit 139 that used to burn a crash-retry too). Fail with the CLI's own reason
    // instead. The message deliberately keeps the `Slicer CLI exited with code N` shape: the
    // API's slicing queue recognizes exit 239 (CLI_PROCESS_NOT_COMPATIBLE: e.g. a stale dialog
    // pairing an X1C process with an H2D machine) and retries without the incompatible built-in
    // profiles, so the slice recovers onto the project's own presets instead of failing.
    const detail = exported.failureDetail ? ` (${exported.failureDetail})` : ''
    input.log(`Could not export merged project settings${detail}`)
    throw new Error(exported.exitCode === 0
      ? `Slicer settings export produced no output while merging project settings for slicing${detail}`
      : `Slicer CLI exited with code ${exported.exitCode ?? 'unknown'} while merging project settings for slicing${detail}`)
  }
  let embeddableSettings = projectSettings
  if (embedded !== null) {
    try {
      embeddableSettings = JSON.stringify({ ...JSON.parse(projectSettings) as Record<string, unknown>, ...embedded })
    } catch {
      // Unparseable export: embed it verbatim; it is still structurally complete for the loader.
    }
  }
  const rewrittenPath = path.join(input.workDir, 'input.with-project-settings.3mf')
  await copyThreeMfWithProjectSettings(input.inputPath, rewrittenPath, embeddableSettings)
  return rewrittenPath
}
