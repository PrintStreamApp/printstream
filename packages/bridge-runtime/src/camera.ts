/**
 * Bambu chamber-camera client.
 *
 * P1/A1-series printers expose a proprietary TLS JPEG stream on port
 * 6000. X/X2/H-series printers expose their chamber camera via RTSP(S),
 * which we proxy through ffmpeg so the rest of the app can consume a
 * uniform stream of JPEG frames.
 */
import { spawn, spawnSync } from 'node:child_process'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { Printer } from '@printstream/shared'
import { isFtpActivityActive, onFtpActivityChange, waitForFtpIdle } from './printer-transport-arbitration.js'

type FfmpegProcess = ReturnType<typeof spawn>

const CAMERA_PORT = 6000
const HEADER_SIZE = 16
const AUTH_PACKET_SIZE = 80
const MAX_FRAME_BYTES = 10_000_000 // 10MB sanity cap
const JPEG_SOI = 0xff
const JPEG_SOI2 = 0xd8
const JPEG_EOI = 0xd9
const FFMPEG_PROCESS_TIMEOUT_MS = 15_000
const FFMPEG_STREAM_STARTUP_TIMEOUT_MS = 10_000
const FFMPEG_STREAM_FRAME_GAP_TIMEOUT_MS = 8_000
const TLS_CAMERA_TIMEOUT_MS = 5_000
const CAMERA_STREAM_RATE_LIMIT_ENABLED = false
const CAMERA_STREAM_MAX_FPS = 15
const CAMERA_STREAM_MIN_INTERVAL_MS = CAMERA_STREAM_RATE_LIMIT_ENABLED ? Math.round(1000 / CAMERA_STREAM_MAX_FPS) : 0
const CAMERA_DEBUG_LOGS = booleanEnv(process.env.CAMERA_DEBUG_LOGS)
const JPEG_START = Buffer.from([0xff, 0xd8])
const JPEG_END = Buffer.from([0xff, 0xd9])

const TLS_CAMERA_MODELS = new Set<Printer['model']>(['P1S', 'P1P', 'A1', 'A1mini'])
const RTSP_CAMERA_MODELS = new Set<Printer['model']>(['X1', 'X1C', 'X1E', 'X2D', 'P2S', 'H2D', 'H2DPRO', 'H2C', 'H2S'])
let hasFfmpegCache: boolean | null = null
const preferredRtspCameraUrls = new Map<string, string>()

function booleanEnv(value: string | undefined): boolean {
  if (!value) return false
  const normalized = value.trim().toLowerCase()
  return normalized === '1' || normalized === 'true'
}

export function supportsChamberCamera(model: Printer['model']): boolean {
  if (TLS_CAMERA_MODELS.has(model)) return true
  if (!RTSP_CAMERA_MODELS.has(model)) return false
  return hasFfmpeg()
}

export function shouldPauseCameraForFtpActivity(model: Printer['model']): boolean {
  return TLS_CAMERA_MODELS.has(model)
}

function buildAuthPacket(accessCode: string): Buffer {
  const buf = Buffer.alloc(AUTH_PACKET_SIZE)
  buf.writeUInt32LE(0x40, 0)
  buf.writeUInt32LE(0x3000, 4)
  // bytes 8..15 already zero
  buf.write('bblp', 16, 4, 'ascii')
  buf.write(accessCode, 48, Math.min(accessCode.length, 32), 'ascii')
  return buf
}

function openCameraSocket(printer: Printer, signal?: AbortSignal): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError())
      return
    }

    const socket = tlsConnect({
      host: printer.host,
      port: CAMERA_PORT,
      rejectUnauthorized: false,
      timeout: TLS_CAMERA_TIMEOUT_MS
    })
    let settled = false

    const cleanup = () => {
      socket.removeListener('error', onError)
      socket.removeListener('timeout', onTimeout)
      socket.removeListener('secureConnect', onSecureConnect)
      signal?.removeEventListener('abort', onAbort)
    }

    const onError = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      socket.destroy()
      reject(error)
    }

    const onTimeout = () => onError(new Error('Camera connection timeout'))

    const onAbort = () => onError(createAbortError())

    const onSecureConnect = () => {
      if (settled) return
      settled = true
      cleanup()
      socket.write(buildAuthPacket(printer.accessCode))
      resolve(socket)
    }

    socket.once('secureConnect', onSecureConnect)
    socket.once('error', onError)
    socket.once('timeout', onTimeout)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Pull a single JPEG frame from the printer. Closes the socket once the
 * first frame has been read.
 */
export async function fetchSnapshot(printer: Printer): Promise<Buffer> {
  if (!supportsChamberCamera(printer.model)) {
    throw new Error(`Camera not supported for model ${printer.model}`)
  }

  for (;;) {
    if (shouldPauseCameraForFtpActivity(printer.model)) {
      await waitForFtpIdle(printer.id)
    }
    const ftpPause = createFtpPauseMonitor(printer.id, printer.model)
    try {
      if (TLS_CAMERA_MODELS.has(printer.model)) {
        const socket = await openCameraSocket(printer, ftpPause.signal)
        try {
          const frame = await readFrame(socket)
          return frame
        } finally {
          socket.destroy()
        }
      }

      return await fetchRtspSnapshot(printer, ftpPause.signal)
    } catch (error) {
      if (ftpPause.wasTriggered()) {
        continue
      }
      throw error
    } finally {
      ftpPause.dispose()
    }
  }
}

/**
 * Async iterator yielding JPEG frames. Source-side throttling is retained but disabled by default.
 * The caller is responsible for closing the iteration (e.g. via a
 * `finally` block or by destroying the underlying socket).
 */
export async function* streamFrames(printer: Printer, signal?: AbortSignal): AsyncGenerator<Buffer, void, void> {
  const limiter = createFrameRateLimiter()

  if (!supportsChamberCamera(printer.model)) {
    throw new Error(`Camera not supported for model ${printer.model}`)
  }

  while (!signal?.aborted) {
    try {
      if (shouldPauseCameraForFtpActivity(printer.model)) {
        await waitForFtpIdle(printer.id, signal)
      }
    } catch {
      return
    }

    const ftpPause = createFtpPauseMonitor(printer.id, printer.model)
    const combined = createCombinedAbortSignal(signal, ftpPause.signal)
    try {
      if (TLS_CAMERA_MODELS.has(printer.model)) {
        const socket = await openCameraSocket(printer, combined.signal)
        try {
          while (!combined.signal.aborted) {
            const frame = await readFrame(socket)
            if (!limiter.shouldEmit()) continue
            yield frame
          }
        } finally {
          socket.destroy()
        }
      } else {
        for await (const frame of streamRtspFrames(printer, combined.signal)) {
          if (!limiter.shouldEmit()) continue
          yield frame
        }
      }
      return
    } catch (error) {
      if (signal?.aborted) {
        return
      }
      if (ftpPause.wasTriggered()) {
        continue
      }
      throw error
    } finally {
      combined.dispose()
      ftpPause.dispose()
    }
  }
}

export function createFrameRateLimiter(input: {
  minIntervalMs?: number
  getNow?: () => number
} = {}): { shouldEmit: () => boolean } {
  const minIntervalMs = input.minIntervalMs ?? CAMERA_STREAM_MIN_INTERVAL_MS
  const getNow = input.getNow ?? (() => Date.now())
  let lastEmittedAt: number | null = null

  return {
    shouldEmit() {
      if (minIntervalMs <= 0) return true
      const now = getNow()
      if (lastEmittedAt != null && now - lastEmittedAt < minIntervalMs) {
        return false
      }
      lastEmittedAt = now
      return true
    }
  }
}

function hasFfmpeg(): boolean {
  if (hasFfmpegCache === true) return true
  try {
    hasFfmpegCache = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0
  } catch {
    hasFfmpegCache = false
  }
  return hasFfmpegCache
}

async function fetchRtspSnapshot(printer: Printer, signal?: AbortSignal): Promise<Buffer> {
  assertFfmpegAvailable()
  let lastError: Error | null = null
  const urls = buildRtspCameraUrls(printer)
  for (const [index, url] of urls.entries()) {
    const startedAt = Date.now()
    try {
      const frame = await captureRtspSnapshot(url, signal)
      rememberWorkingRtspCameraUrl(printer, url)
      if (CAMERA_DEBUG_LOGS) {
        console.debug(
          `[camera:rtsp:${printer.id}] snapshot ready url=${describeRtspCameraUrl(url)} candidate=${index + 1}/${urls.length} totalMs=${Date.now() - startedAt}`
        )
      }
      return frame
    } catch (error) {
      lastError = error as Error
      console.warn(
        `[camera:rtsp:${printer.id}] snapshot candidate failed url=${describeRtspCameraUrl(url)} candidate=${index + 1}/${urls.length} totalMs=${Date.now() - startedAt} error=${lastError.message}`
      )
    }
  }
  throw lastError ?? new Error(`Camera not supported for model ${printer.model}`)
}

async function* streamRtspFrames(printer: Printer, signal?: AbortSignal): AsyncGenerator<Buffer, void, void> {
  assertFfmpegAvailable()
  let lastError: Error | null = null
  const urls = buildRtspCameraUrls(printer)
  for (const [index, url] of urls.entries()) {
    const startedAt = Date.now()
    let yielded = false
    try {
      for await (const frame of streamRtspFramesFromUrl(url, signal)) {
        if (!yielded) {
          rememberWorkingRtspCameraUrl(printer, url)
          if (CAMERA_DEBUG_LOGS) {
            console.debug(
              `[camera:rtsp:${printer.id}] first frame url=${describeRtspCameraUrl(url)} candidate=${index + 1}/${urls.length} firstFrameMs=${Date.now() - startedAt}`
            )
          }
        }
        yielded = true
        yield frame
      }
      return
    } catch (error) {
      if (yielded || signal?.aborted) throw error
      lastError = error as Error
      console.warn(
        `[camera:rtsp:${printer.id}] stream candidate failed url=${describeRtspCameraUrl(url)} candidate=${index + 1}/${urls.length} totalMs=${Date.now() - startedAt} error=${lastError.message}`
      )
    }
  }
  throw lastError ?? new Error(`Camera not supported for model ${printer.model}`)
}

async function captureRtspSnapshot(url: string, signal?: AbortSignal): Promise<Buffer> {
  const process = spawnFfmpeg([
    '-hide_banner',
    '-loglevel', 'error',
    ...buildRtspFfmpegInputArgs(url),
    '-an',
    '-frames:v', '1',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    'pipe:1'
  ])

  return withFfmpegProcess(process, async () => {
    const stdout = getFfmpegStdout(process)
    const chunks: Buffer[] = []
    for await (const chunk of stdout) {
      chunks.push(chunk)
    }
    const frame = Buffer.concat(chunks)
    if (frame.length < 2 || frame[0] !== JPEG_SOI || frame[1] !== JPEG_SOI2) {
      throw new Error('Camera: ffmpeg did not return a JPEG frame')
    }
    return frame
  }, signal)
}

function createAbortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

function createCombinedAbortSignal(...signals: Array<AbortSignal | undefined>): {
  signal: AbortSignal
  dispose: () => void
} {
  const controller = new AbortController()
  const removers = signals.map((source) => {
    if (!source) return () => undefined

    const onAbort = () => {
      if (!controller.signal.aborted) {
        controller.abort(source.reason)
      }
    }

    if (source.aborted) {
      onAbort()
      return () => undefined
    }

    source.addEventListener('abort', onAbort, { once: true })
    return () => source.removeEventListener('abort', onAbort)
  })

  return {
    signal: controller.signal,
    dispose: () => {
      for (const remove of removers) {
        remove()
      }
    }
  }
}

function createFtpPauseMonitor(printerId: string, model: Printer['model']): {
  signal: AbortSignal
  wasTriggered: () => boolean
  dispose: () => void
} {
  const controller = new AbortController()
  let triggered = false

  if (!shouldPauseCameraForFtpActivity(model)) {
    return {
      signal: controller.signal,
      wasTriggered: () => false,
      dispose: () => undefined
    }
  }

  const unsubscribe = onFtpActivityChange(printerId, (active) => {
    if (!active || controller.signal.aborted) return
    triggered = true
    controller.abort(createAbortError())
  })

  if (isFtpActivityActive(printerId)) {
    triggered = true
    controller.abort(createAbortError())
  }

  return {
    signal: controller.signal,
    wasTriggered: () => triggered,
    dispose: unsubscribe
  }
}

async function* streamRtspFramesFromUrl(url: string, signal?: AbortSignal): AsyncGenerator<Buffer, void, void> {
  const process = spawnFfmpeg([
    '-hide_banner',
    '-loglevel', 'error',
    ...buildRtspFfmpegInputArgs(url),
    '-an',
    ...buildRtspFfmpegStreamOutputArgs(),
    '-q:v', '5',
    'pipe:1'
  ])

  yield* withFfmpegStream(process, async function* () {
    const stdout = getFfmpegStdout(process)
    let pending = Buffer.alloc(0)
    for await (const chunk of stdout) {
      if (signal?.aborted) return
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      while (true) {
        const start = pending.indexOf(JPEG_START)
        if (start < 0) {
          pending = pending.subarray(Math.max(0, pending.length - 1))
          break
        }
        const end = pending.indexOf(JPEG_END, start + 2)
        if (end < 0) {
          pending = pending.subarray(start)
          break
        }
        const frame = pending.subarray(start, end + 2)
        pending = pending.subarray(end + 2)
        if (frame.length >= 2 && frame[0] === JPEG_SOI && frame[1] === JPEG_SOI2 && frame[frame.length - 1] === JPEG_EOI) {
          yield frame
        }
      }
    }
  }, signal)
}

export function buildRtspCameraUrls(printer: Printer): string[] {
  const encodedAccessCode = encodeURIComponent(printer.accessCode)
  const candidates = Array.from(new Set([
    `rtsps://bblp:${encodedAccessCode}@${printer.host}:322/streaming/live/1`,
    `rtsps://bblp:${encodedAccessCode}@${printer.host}/streaming/live/1`,
    `rtsp://bblp:${encodedAccessCode}@${printer.host}:322/streaming/live/1`,
    `rtsp://bblp:${encodedAccessCode}@${printer.host}/streaming/live/1`
  ]))

  const preferredUrl = preferredRtspCameraUrls.get(rtspCameraPreferenceKey(printer))
  if (!preferredUrl) return candidates

  const preferredIndex = candidates.indexOf(preferredUrl)
  if (preferredIndex <= 0) return candidates

  const ordered = [...candidates]
  const [preferred] = ordered.splice(preferredIndex, 1)
  ordered.unshift(preferred as string)
  return ordered
}

function rememberWorkingRtspCameraUrl(printer: Printer, url: string): void {
  preferredRtspCameraUrls.set(rtspCameraPreferenceKey(printer), url)
}

function rtspCameraPreferenceKey(printer: Printer): string {
  return printer.serial || printer.id
}

export function clearPreferredRtspCameraUrlsForTests(): void {
  preferredRtspCameraUrls.clear()
}

export function setPreferredRtspCameraUrlForTests(printer: Printer, url: string | null): void {
  const key = rtspCameraPreferenceKey(printer)
  if (!url) {
    preferredRtspCameraUrls.delete(key)
    return
  }
  preferredRtspCameraUrls.set(key, url)
}

export function buildRtspFfmpegInputArgs(url: string): string[] {
  return [
    '-rtsp_transport', 'tcp',
    '-fflags', 'nobuffer',
    '-flags', 'low_delay',
    '-analyzeduration', '0',
    '-probesize', '32',
    '-i', url
  ]
}

export function buildRtspFfmpegStreamOutputArgs(): string[] {
  return [
    // Bambu RTSP cameras periodically reset/wrap their RTP timestamps, and at low
    // frame rates multiple frames can share a timestamp. Both surface as
    // non-monotonic pts/dts ("Invalid pts <= last", "non monotonically increasing
    // dts to muxer") and abort the mjpeg encoder / image2pipe muxer. We re-split
    // the output into JPEG frames by SOI/EOI markers ourselves, so the source
    // timestamps carry no information we need: rewrite each frame's PTS from its
    // frame index (`setpts=N/TB`) so the encoder and muxer always see a strictly
    // increasing timestamp regardless of what the camera reports.
    '-vsync', '0',
    '-vf', 'setpts=N/TB',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg'
  ]
}

export function createStreamFrameWatchdog(input: {
  onTimeout: (event: { reason: 'startup' | 'frame-gap'; timeoutMs: number }) => void
  startupTimeoutMs?: number
  frameGapTimeoutMs?: number
}): {
  noteFrame: () => void
  stop: () => void
} {
  let timer: NodeJS.Timeout | null = null
  let stopped = false
  let sawFrame = false

  const arm = (timeoutMs: number) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      if (stopped) return
      input.onTimeout({
        reason: sawFrame ? 'frame-gap' : 'startup',
        timeoutMs
      })
    }, timeoutMs)
  }

  arm(input.startupTimeoutMs ?? FFMPEG_STREAM_STARTUP_TIMEOUT_MS)

  return {
    noteFrame() {
      if (stopped) return
      sawFrame = true
      arm(input.frameGapTimeoutMs ?? FFMPEG_STREAM_FRAME_GAP_TIMEOUT_MS)
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = null
    }
  }
}

function spawnFfmpeg(args: string[]): FfmpegProcess {
  try {
    return spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (error) {
    throw new Error(`Camera: failed to start ffmpeg (${(error as Error).message})`)
  }
}

async function withFfmpegProcess<T>(
  process: FfmpegProcess,
  run: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  const stderrChunks: Buffer[] = []
  getFfmpegStderr(process).on('data', (chunk: Buffer) => {
    stderrChunks.push(chunk)
    if (stderrChunks.length > 64) stderrChunks.shift()
  })

  const abort = () => {
    if (!process.killed) process.kill('SIGKILL')
  }
  const timer = setTimeout(abort, FFMPEG_PROCESS_TIMEOUT_MS)
  signal?.addEventListener('abort', abort, { once: true })

  const waitForExit = () => new Promise<void>((resolve, reject) => {
    process.once('error', reject)
    process.once('close', (code, closeSignal) => {
      if (signal?.aborted || closeSignal === 'SIGKILL') {
        resolve()
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(formatFfmpegError(stderrChunks, code)))
    })
  })

  try {
    const value = await run()
    await waitForExit()
    return value
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
    if (!process.killed) process.kill('SIGKILL')
  }
}

async function* withFfmpegStream<T>(
  process: FfmpegProcess,
  run: () => AsyncGenerator<T, void, void>,
  signal?: AbortSignal
): AsyncGenerator<T, void, void> {
  const stderrChunks: Buffer[] = []
  const stderr = getFfmpegStderr(process)
  let timeoutEvent: { reason: 'startup' | 'frame-gap'; timeoutMs: number } | null = null

  const onStderrData = (chunk: Buffer) => {
    stderrChunks.push(chunk)
    if (stderrChunks.length > 64) stderrChunks.shift()
  }

  const abort = () => {
    if (!process.killed) process.kill('SIGKILL')
  }
  const watchdog = createStreamFrameWatchdog({
    onTimeout(event) {
      timeoutEvent = event
      abort()
    }
  })
  stderr.on('data', onStderrData)
  signal?.addEventListener('abort', abort, { once: true })

  const waitForExit = () => new Promise<void>((resolve, reject) => {
    process.once('error', reject)
    process.once('close', (code, closeSignal) => {
      if (signal?.aborted) {
        resolve()
        return
      }
      if (closeSignal === 'SIGKILL') {
        if (timeoutEvent) {
          reject(new Error(formatFfmpegStreamTimeoutError(timeoutEvent)))
          return
        }
        resolve()
        return
      }
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(formatFfmpegError(stderrChunks, code)))
    })
  })

  try {
    for await (const entry of run()) {
      watchdog.noteFrame()
      yield entry
    }
    await waitForExit()
  } finally {
    watchdog.stop()
    signal?.removeEventListener('abort', abort)
    stderr.off('data', onStderrData)
    if (!process.killed) process.kill('SIGKILL')
  }
}

function formatFfmpegError(stderrChunks: Buffer[], code: number | null): string {
  const detail = Buffer.concat(stderrChunks).toString('utf8').trim().split(/\r?\n/u).filter(Boolean).slice(-3).join(' | ')
  return detail
    ? `Camera: ffmpeg exited with code ${code ?? 'unknown'} (${detail})`
    : `Camera: ffmpeg exited with code ${code ?? 'unknown'}`
}

function formatFfmpegStreamTimeoutError(event: { reason: 'startup' | 'frame-gap'; timeoutMs: number }): string {
  if (event.reason === 'startup') {
    return `Camera: ffmpeg produced no first frame within ${event.timeoutMs}ms`
  }
  return `Camera: ffmpeg stalled with no frame for ${event.timeoutMs}ms`
}

function describeRtspCameraUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const port = parsed.port ? `:${parsed.port}` : ''
    return `${parsed.protocol}//${parsed.hostname}${port}${parsed.pathname}`
  } catch {
    return 'invalid-rtsp-url'
  }
}

function getFfmpegStdout(process: FfmpegProcess) {
  if (!process.stdout) throw new Error('Camera: ffmpeg stdout is unavailable')
  return process.stdout
}

function getFfmpegStderr(process: FfmpegProcess) {
  if (!process.stderr) throw new Error('Camera: ffmpeg stderr is unavailable')
  return process.stderr
}

function assertFfmpegAvailable(): void {
  if (!hasFfmpeg()) {
    throw new Error('Camera: ffmpeg is required for RTSP camera support')
  }
}

async function readFrame(socket: TLSSocket): Promise<Buffer> {
  const header = await readExactly(socket, HEADER_SIZE)
  const payloadSize = header.readUInt32LE(0)
  if (payloadSize === 0 || payloadSize > MAX_FRAME_BYTES) {
    throw new Error(`Camera: invalid frame size ${payloadSize}`)
  }
  const frame = await readExactly(socket, payloadSize)
  if (frame.length < 2 || frame[0] !== JPEG_SOI || frame[1] !== JPEG_SOI2) {
    throw new Error('Camera: payload is not a JPEG')
  }
  return frame
}

function readExactly(socket: TLSSocket, length: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let received = 0

    const onData = (chunk: Buffer) => {
      const need = length - received
      if (chunk.length <= need) {
        chunks.push(chunk)
        received += chunk.length
        if (received === length) finish()
        return
      }
      chunks.push(chunk.subarray(0, need))
      received = length
      // Push back the rest so the next readExactly can consume it.
      socket.unshift(chunk.subarray(need))
      finish()
    }

    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }

    const onClose = () => {
      cleanup()
      reject(new Error('Camera connection closed'))
    }

    const cleanup = () => {
      socket.off('data', onData)
      socket.off('error', onError)
      socket.off('close', onClose)
    }

    const finish = () => {
      cleanup()
      resolve(Buffer.concat(chunks, length))
    }

    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}
