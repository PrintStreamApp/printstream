/**
 * Ensure a to-be-sliced 3MF carries a `Metadata/project_settings.config`.
 *
 * A "from scratch" project 3MF (PrintStream's calibration scaffolds, built by
 * `buildEditedThreeMf(null, …)`) carries the `Application: BambuStudio-…` marker so the CLI takes
 * its BBL-project path — which is required to slice per-plate and keep the injected
 * `custom_gcode_per_layer.xml` (without the marker the CLI logs "not support to slice plate N,
 * reset to 0" and drops the per-layer G-code). But that BBL-project loader dereferences the
 * project's embedded `project_settings.config`, and a minimal scaffold 3MF has none — so the CLI
 * segfaults (SIGSEGV / exit 139) at load, before it reads the model.
 *
 * A hand-merge of the machine/process/filament presets does NOT satisfy the loader (it fills ~150
 * defaulted keys the presets omit). So we let BambuStudio itself produce a genuine merged config
 * via a fast `--export-settings` pass over the very `--load-settings`/`--load-filaments` the slice
 * will use, then embed that as the 3MF's `project_settings.config`. The slice's own
 * `--load-settings` still overrides these values (3mf-embedded settings are lowest priority), so
 * the embedded config only needs to be structurally complete — which a genuine export is.
 *
 * A no-op when the 3MF already embeds `project_settings.config` (every real BambuStudio project),
 * so normal slicing is untouched.
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import yazl from 'yazl'
import { type Entry } from 'yauzl'
import { openZip, readZipEntryBuffer, readZipEntryText } from './zip-io.js'

const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'

/** Whether the 3MF already embeds a `project_settings.config` (any real BambuStudio project does). */
export async function hasEmbeddedProjectSettings(inputPath: string): Promise<boolean> {
  const text = await readZipEntryText(inputPath, PROJECT_SETTINGS_ENTRY).catch(() => null)
  return typeof text === 'string' && text.trim().length > 0
}

/** Run the CLI with the given profile args + `--export-settings` and return the exported JSON, or null. */
async function exportMergedProjectSettings(input: {
  cliPath: string
  appDir: string | null
  profileArgs: readonly string[]
  workDir: string
  env: NodeJS.ProcessEnv
  signal?: AbortSignal
}): Promise<string | null> {
  // `--export-settings` writes the fully merged `--load-settings`/`--load-filaments` config; it
  // needs no input model and does not slice, so it is fast. Absolute output path (no `--outputdir`).
  const settingsPath = path.join(input.workDir, `project-settings-${randomUUID()}.config`)
  const args = [...input.profileArgs, '--export-settings', settingsPath]
  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const child = spawn(input.cliPath, args, {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...input.env, SLICER_APPDIR: input.appDir ?? input.env.SLICER_APPDIR }
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-2000) })
    const onAbort = () => { try { child.kill('SIGKILL') } catch { /* already gone */ } }
    input.signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (error) => { input.signal?.removeEventListener('abort', onAbort); reject(error) })
    child.on('close', (code) => { input.signal?.removeEventListener('abort', onAbort); resolve(code) })
  })
  if (exitCode !== 0) {
    await rm(settingsPath, { force: true }).catch(() => undefined)
    return null
  }
  const content = await readFile(settingsPath, 'utf8').catch(() => null)
  await rm(settingsPath, { force: true }).catch(() => undefined)
  return content && content.trim().length > 0 ? content : null
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
 * If `inputPath` lacks `project_settings.config`, synthesize one from the slice's own profile args
 * (via {@link exportMergedProjectSettings}) and return the path to a rewritten 3MF that embeds it.
 * Returns `inputPath` unchanged when it already has one, or when synthesis fails (best-effort — the
 * slice then proceeds and surfaces its own error rather than this masking it).
 */
export async function ensureEmbeddedProjectSettings(input: {
  inputPath: string
  cliPath: string
  appDir: string | null
  profileArgs: readonly string[]
  workDir: string
  env: NodeJS.ProcessEnv
  log: (message: string) => void
  signal?: AbortSignal
}): Promise<string> {
  // Only scaffold 3MFs sliced with external presets need this; a `--load-settings`-free slice would
  // have nothing to synthesize from.
  const hasLoadSettings = input.profileArgs.includes('--load-settings') || input.profileArgs.includes('--load-filaments')
  if (!hasLoadSettings) return input.inputPath
  if (await hasEmbeddedProjectSettings(input.inputPath)) return input.inputPath

  input.log('Synthesizing project settings for scaffold 3MF (no embedded project_settings.config)')
  const projectSettings = await exportMergedProjectSettings({
    cliPath: input.cliPath,
    appDir: input.appDir,
    profileArgs: input.profileArgs,
    workDir: input.workDir,
    env: input.env,
    signal: input.signal
  })
  if (!projectSettings) {
    input.log('Could not export merged project settings; slicing the scaffold 3MF as-is')
    return input.inputPath
  }
  const rewrittenPath = path.join(input.workDir, 'input.with-project-settings.3mf')
  await copyThreeMfWithProjectSettings(input.inputPath, rewrittenPath, projectSettings)
  return rewrittenPath
}
