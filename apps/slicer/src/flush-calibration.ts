/**
 * Asks BambuStudio to compute a flush matrix itself, so our port can be checked against the engine
 * that will actually slice.
 *
 * WHY. The flush calculation exists twice: BambuStudio's compiled code, and our port of it
 * (`@printstream/shared` `flush-volume-calc.ts`). The port is verified against the vendored SOURCE,
 * but the slicer IMAGE and that vendored source are bumped independently, so an engine upgrade
 * can move the numbers with nothing failing anywhere. This closes that gap: the engine is asked for
 * its own answer at runtime, and disagreement becomes observable instead of silent.
 *
 * HOW. The CLI recomputes `flush_volumes_matrix` whenever `--filament-colour` is passed
 * (`BambuStudio.cpp`, the block guarded on `selected_filament_colors_option`), and
 * `--export-settings` runs that path WITHOUT slicing and without an input model, so this is a
 * fast, model-free probe rather than a slice. It returns both the merged settings the engine
 * produced and the matrix it computed from them, so the caller can re-derive from exactly those
 * inputs and compare like for like (`evaluateFlushCalibration`).
 *
 * This is a DIAGNOSTIC, not the source of the numbers users edit: it runs once per target and is
 * cached, because a CLI round-trip is far too slow to sit behind a grid someone is typing in.
 *
 * It already earned its keep, it caught `readProjectFlushContext` reading a variant-wide machine
 * array positionally, which mis-priced every purge on a dual-nozzle machine's SECOND extruder while
 * the first stayed correct. No amount of testing the calculator could have found that.
 */
import { spawn } from 'node:child_process'
import { engineProcessEnvironment, engineProcessIdentity } from './engine-process-security.js'
import { readFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

/** The engine's own answer, plus the exact settings it derived it from. */
export interface FlushCalibrationResult {
  /** The merged `project_settings.config` the engine exported, as raw JSON text. */
  settingsJson: string
  /** `flush_volumes_matrix` as the engine computed it, one filaments^2 block per extruder. */
  matrix: string[]
  /** Which presets the probe used, for diagnostics when it disagrees. */
  profiles: { machine: string; process: string; filament: string }
  /** The colours fed in, in the order the matrix's rows/columns follow. */
  colors: string[]
}

/**
 * Colours the probe asks about.
 *
 * Deliberately mixed: two are Bambu's own measured palette entries (so the measured-table path is
 * exercised) and one is not (so the colour formula is too). A probe that only hit the table would
 * pass while the formula drifted, and vice versa.
 */
const PROBE_COLORS = ['#000000FF', '#F4EE2AFF', '#123456FF'] as const

/** How long the probe may take. Generous: an emulated (arm64/qemu) engine is far slower than x86. */
const PROBE_TIMEOUT_MS = 120_000

export interface FlushCalibrationInput {
  cliPath: string
  appDir: string | null
  /** The target's flattened profile root, holding `machine_full`/`process_full`/`filament_full`. */
  profileDir: string
  /** A machine/process/filament preset triple to probe with. */
  profiles: { machine: string; process: string; filament: string }
  workDir: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}

/**
 * Run the probe. Returns null when the engine could not answer, no slicer, a preset triple this
 * image does not carry, a timeout. That is a supported outcome: calibration is a diagnostic, so its
 * absence must never break the feature it is checking.
 */
export async function runFlushCalibration(input: FlushCalibrationInput): Promise<FlushCalibrationResult | null> {
  const settingsPath = path.join(input.workDir, `flush-calibration-${randomUUID()}.config`)
  const args = [
    '--load-settings', [
      path.join(input.profileDir, 'machine_full', `${input.profiles.machine}.json`),
      path.join(input.profileDir, 'process_full', `${input.profiles.process}.json`)
    ].join(';'),
    // One entry per probe colour: the engine sizes the matrix on the filament count, and a short
    // filament list would silently probe fewer slots than the colours describe.
    '--load-filaments', PROBE_COLORS
      .map(() => path.join(input.profileDir, 'filament_full', `${input.profiles.filament}.json`))
      .join(';'),
    '--filament-colour', PROBE_COLORS.join(';'),
    '--export-settings', settingsPath
  ]

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(input.cliPath, args, {
        ...engineProcessIdentity(),
        stdio: ['ignore', 'ignore', 'ignore'],
        env: engineProcessEnvironment(input.env, {
          SLICER_APPDIR: input.appDir ?? input.env.SLICER_APPDIR
        })
      })
      const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, PROBE_TIMEOUT_MS)
      const onAbort = () => { try { child.kill('SIGKILL') } catch { /* already gone */ } }
      input.signal?.addEventListener('abort', onAbort, { once: true })
      child.on('error', (error) => { clearTimeout(timer); reject(error) })
      child.on('close', (code) => { clearTimeout(timer); resolve(code) })
    })
    if (exitCode !== 0) return null

    const settingsJson = await readFile(settingsPath, 'utf8')
    const parsed: unknown = JSON.parse(settingsJson)
    if (!parsed || typeof parsed !== 'object') return null
    const matrix = (parsed as Record<string, unknown>).flush_volumes_matrix
    if (!Array.isArray(matrix) || matrix.length === 0) return null
    return {
      settingsJson,
      matrix: matrix.map((entry) => String(entry)),
      profiles: input.profiles,
      colors: [...PROBE_COLORS]
    }
  } catch (error) {
    // The verdict degrades to "unchecked", which is indistinguishable from "no slicer to ask" at
    // every surface above, so log the reason here or a probe that is failing for a REAL cause
    // (missing CLI, unreadable export) looks exactly like one that was never attempted.
    console.warn('[slicer] flush calibration probe failed', (error as Error).message)
    return null
  } finally {
    await rm(settingsPath, { force: true }).catch(() => { /* best effort */ })
  }
}
