/**
 * Native slicer process execution and CLI capability probing.
 *
 * HTTP routing supplies a validated target, isolated directories, output lines,
 * and an abort signal. This module owns process identity, progress capture,
 * stall/completion timers, failure grading, and child-process cleanup. The
 * per-target flag cache lives here beside its probe so route handlers share it.
 */
import { createReadStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import path from 'node:path'
import type { SlicingOutputLine } from '@printstream/shared'
import { env } from './env.js'
import { terminateSlicerChild } from './terminate-child.js'
import { outputSignalsSliceComplete } from './slice-progress.js'
import { appendCappedTail, appendOutput, appendStructuredOutput } from './slice-output.js'
import { classifyCliFailure, formatRuntimeCompatibilityError } from './slice-error.js'
import { engineProcessEnvironment, engineProcessIdentity } from './engine-process-security.js'
import type { RuntimeSlicerTarget } from './slicer-targets.js'

const cliSupportedFlagsCache = new Map<string, Set<string>>()

export async function getSupportedCliFlags(
  slicerTarget: RuntimeSlicerTarget,
  directories: {
    jobKey: string
    bambuHomeDir: string
    bambuConfigDir: string
    bambuCacheDir: string
    bambuDataDir: string
  }
): Promise<Set<string>> {
  const cached = cliSupportedFlagsCache.get(slicerTarget.id)
  if (cached) return cached

  const helpText = await new Promise<string>((resolve, reject) => {
    const child = spawn(slicerTarget.cliPath, [...slicerTarget.cliArgsPrefix, '--help'], {
      ...engineProcessIdentity(directories.jobKey),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: engineProcessEnvironment(process.env, {
        SLICER_APPDIR: slicerTarget.appDir ?? process.env.SLICER_APPDIR,
        HOME: directories.bambuHomeDir,
        XDG_CONFIG_HOME: directories.bambuConfigDir,
        XDG_CACHE_HOME: directories.bambuCacheDir,
        XDG_DATA_HOME: directories.bambuDataDir
      })
    })
    let stdout = ''
    let stderr = ''

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      const compatibilityError = formatRuntimeCompatibilityError(stderr || stdout)
      if (compatibilityError) {
        console.warn(`[slicer:getSupportedCliFlags] --help probe failed: ${compatibilityError}`)
        reject(new Error(compatibilityError))
        return
      }
      const helpError = stderr.trim() || stdout.trim() || `Slicer CLI help exited with code ${code ?? 'unknown'}`
      console.warn(`[slicer:getSupportedCliFlags] --help probe failed: ${helpError}`)
      reject(new Error(helpError))
    })
  })

  const flags = new Set((helpText.match(/--[a-z0-9-]+/gi) ?? []).map((entry) => entry.toLowerCase()))
  cliSupportedFlagsCache.set(slicerTarget.id, flags)
  return flags
}

export async function executeCli(input: {
  slicerTarget: RuntimeSlicerTarget
  args: string[]
  outputPath: string
  outputLines: SlicingOutputLine[]
  supportedFlags: ReadonlySet<string>
  bambuHomeDir: string
  bambuConfigDir: string
  bambuCacheDir: string
  bambuDataDir: string
  jobKey: string
  jobTempDir: string
  maxOutputBytes: number
  /** Aborted on client cancel; kills the CLI child so the slicer slot frees. */
  signal?: AbortSignal
}): Promise<void> {
  const jobTempDir = input.jobTempDir
  let progressPipePath: string | null = null
  let progressPipeReader: ReturnType<typeof createReadStream> | null = null
  const args = [...input.args]
  // Liveness + completion tracking, shared by the CLI stdout/stderr streams and the
  // optional --pipe channel, and read by the stall/success guard in the Promise below.
  let lastOutputAt = Date.now()
  let sliceSucceeded = false
  // The only buffer that sees every channel. BambuStudio writes its `total_percent` progress
  // frames exclusively to the --pipe FIFO, so `stdoutCombined`/`stderrCombined` below cannot
  // answer "how far did this run get?" and the crash grader must read this instead
  // (see the `slice-error.ts` header). Scoped per executeCli call on purpose: in the all-plate
  // fallback each plate must be graded on its own progress, not its predecessor's 100%. Tail-capped
  // like the other two, which fails SAFE: losing the frames can only under-report progress, and an
  // under-reported crash is retried once, exactly as it was before this buffer existed.
  let allChannelsCombined = ''
  const noteOutput = (text: string): void => {
    lastOutputAt = Date.now()
    allChannelsCombined = appendCappedTail(allChannelsCombined, text)
    if (!sliceSucceeded && outputSignalsSliceComplete(text)) sliceSucceeded = true
  }
  if (env.SLICER_ENABLE_PIPE_PROGRESS && input.supportedFlags.has('--pipe') && !args.includes('--pipe')) {
    try {
      progressPipePath = path.join(path.dirname(input.outputPath), `${input.slicerTarget.id}-${randomUUID()}.pipe`)
      await rm(progressPipePath, { force: true })
      await mkfifo(progressPipePath, input.jobKey)
      progressPipeReader = createReadStream(progressPipePath, { encoding: 'utf8' })
      progressPipeReader.on('data', (chunk: string | Buffer) => {
        const text = String(chunk)
        appendOutput(input.outputLines, 'stdout', text)
        noteOutput(text)
      })
      progressPipeReader.on('error', (error) => {
        appendStructuredOutput(input.outputLines, 'system', `Progress pipe read failed: ${error.message}`)
      })
      args.push('--pipe', progressPipePath)
    } catch (error) {
      appendStructuredOutput(input.outputLines, 'system', `Failed to enable --pipe progress: ${String((error as Error)?.message ?? error)}`)
      if (progressPipePath) await rm(progressPipePath, { force: true }).catch(() => undefined)
      progressPipePath = null
      progressPipeReader = null
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let stderrCombined = ''
      let stdoutCombined = ''
      const child = spawn(input.slicerTarget.cliPath, [...input.slicerTarget.cliArgsPrefix, ...args], {
        ...engineProcessIdentity(input.jobKey),
        // `detached` makes the child its own process-group leader so termination can
        // signal the whole group: the launcher runs the CLI with helper processes
        // (a per-slice weston; qemu on arm64) that a bare child.kill() would orphan.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: engineProcessEnvironment(process.env, {
          SLICER_APPDIR: input.slicerTarget.appDir ?? process.env.SLICER_APPDIR,
          HOME: input.bambuHomeDir,
          XDG_CONFIG_HOME: input.bambuConfigDir,
          XDG_CACHE_HOME: input.bambuCacheDir,
          XDG_DATA_HOME: input.bambuDataDir,
          TMPDIR: jobTempDir,
          SLICER_MAX_FILE_BLOCKS: String(Math.ceil(input.maxOutputBytes / 512))
        })
      })
      // Reset the stall clock to the moment the CLI actually starts.
      lastOutputAt = Date.now()
      // Cancels the SIGTERM->SIGKILL escalation once the child actually exits.
      let cancelTermination: (() => void) | null = null
      let successGraceTimer: ReturnType<typeof setTimeout> | null = null
      const timeout = setTimeout(() => {
        console.warn(`[slicer:executeCli] timed out after ${env.SLICER_TIMEOUT_MS}ms; terminating CLI`)
        cancelTermination = terminateSlicerChild(child)
        reject(new Error('Slicer CLI timed out'))
      }, env.SLICER_TIMEOUT_MS)
      // Stall + completion guard (polled):
      //  - Once BambuStudio reports "All done, Success" the artifact is fully written; give
      //    the process a short grace to exit, then force it (qemu teardown can hang without
      //    ever firing 'close', leaving orphaned launcher helpers) and treat the slice as done.
      //  - Otherwise, if the CLI has produced no output for SLICER_STALL_TIMEOUT_MS it is
      //    wedged (commonly the emulated "Exporting 3mf" step at 97%); terminate and fail
      //    fast rather than waiting out the full SLICER_TIMEOUT_MS.
      const guard = setInterval(() => {
        if (sliceSucceeded) {
          if (!successGraceTimer) {
            successGraceTimer = setTimeout(() => {
              console.warn('[slicer:executeCli] CLI reported success but has not exited; terminating after grace')
              cancelTermination = terminateSlicerChild(child)
              resolve()
            }, env.SLICER_SUCCESS_EXIT_GRACE_MS)
            successGraceTimer.unref?.()
          }
          return
        }
        const idleMs = Date.now() - lastOutputAt
        if (idleMs >= env.SLICER_STALL_TIMEOUT_MS) {
          console.warn(`[slicer:executeCli] no CLI output for ${idleMs}ms; terminating (stalled)`)
          cancelTermination = terminateSlicerChild(child)
          reject(new Error('Slicer stopped responding (no progress). It may have stalled: try slicing again.'))
        }
      }, 5_000)
      guard.unref?.()
      const clearTimers = () => {
        clearTimeout(timeout)
        clearInterval(guard)
        if (successGraceTimer) clearTimeout(successGraceTimer)
      }
      // Client cancel: kill the CLI so it stops occupying a slicer slot (otherwise it runs to
      // completion and the next queued job waits on a zombie).
      const onAbort = () => {
        console.warn('[slicer:executeCli] client cancelled; terminating CLI')
        cancelTermination = terminateSlicerChild(child)
        clearTimers()
        reject(new Error('Slicing cancelled'))
      }
      if (input.signal) {
        if (input.signal.aborted) { onAbort(); return }
        input.signal.addEventListener('abort', onAbort, { once: true })
      }
      const cleanupAbort = () => {
        cancelTermination?.()
        input.signal?.removeEventListener('abort', onAbort)
      }

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        stdoutCombined = appendCappedTail(stdoutCombined, chunk)
        appendOutput(input.outputLines, 'stdout', chunk)
        noteOutput(chunk)
      })
      child.stderr.on('data', (chunk: string) => {
        stderrCombined = appendCappedTail(stderrCombined, chunk)
        appendOutput(input.outputLines, 'stderr', chunk)
        noteOutput(chunk)
      })
      child.on('error', (error) => {
        clearTimers()
        cleanupAbort()
        reject(error)
      })
      child.on('close', (code) => {
        clearTimers()
        cleanupAbort()
        // Trust BambuStudio's own success marker over a non-zero teardown exit under
        // emulation: the artifact is already fully written.
        if (sliceSucceeded || code === 0) resolve()
        else {
          const stderrTail = stderrCombined.trim().split(/\r?\n/u).filter(Boolean).slice(-5).join(' | ')
          console.warn(
            `[slicer:executeCli] CLI exited with code ${code ?? 'unknown'}${stderrTail ? ` (${stderrTail})` : ''}`
          )
          // `slice-error.ts` owns which explanation wins and, critically, which text each one is
          // graded on: the crash grader needs the --pipe progress frames, which live only in
          // `allChannelsCombined`.
          reject(new Error(classifyCliFailure({
            allChannelsText: allChannelsCombined,
            stdoutText: stdoutCombined,
            stderrText: stderrCombined,
            exitCode: code
          })))
        }
      })
    })
  } finally {
    progressPipeReader?.destroy()
    if (progressPipePath) {
      await rm(progressPipePath, { force: true }).catch(() => undefined)
    }
  }
}

async function mkfifo(pipePath: string, jobKey: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('mkfifo', [pipePath], {
      ...engineProcessIdentity(jobKey),
      stdio: 'ignore'
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`mkfifo exited with code ${code ?? 'unknown'}`))
    })
  })
}
