/**
 * Owns bounded, short-lived URL downloads awaiting a library destination. Bytes
 * never become library files before confirmation. Tokens are bound to workspace
 * and actor; confirmation replays one result and cancellation cannot interrupt
 * persistence. Assumes one API node, like the existing remote-download path.
 */
import { randomUUID } from 'node:crypto'
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { createKeyedMutex } from '../../lib/keyed-mutex.js'
import { badRequest, conflict, notFound } from '../../lib/http-error.js'

export interface PreparedDownload {
  sourceUrl: string
  fileName: string
  filePath: string
  cleanupPath: string
  sizeBytes: number
}

interface Entry<T> {
  owner: string
  expiresAt: number
  download: PreparedDownload
  confirmation?: string
  result?: T
  completed: boolean
}

const LIFETIME_MS = 10 * 60_000

export class PreparedImports<T> {
  private readonly entries = new Map<string, Entry<T>>()
  private readonly mutex = createKeyedMutex()
  private preparing = 0
  private readonly downloads = new Set<AbortController>()
  private closed = false
  private readonly timer: ReturnType<typeof setInterval>

  constructor(private readonly directory: string, private readonly warn: (message: string, error: unknown) => void) {
    this.timer = setInterval(() => { void this.sweep().catch((error) => this.warn('Could not clean prepared model downloads', error)) }, 60_000)
    this.timer.unref()
  }

  /** Reserve capacity before network work; a lost response is reclaimed by expiry. */
  async prepare(owner: string, download: (signal: AbortSignal) => Promise<PreparedDownload>) {
    if (this.closed) throw conflict('Model importing is shutting down. Try again shortly.')
    await this.sweep()
    const pending = [...this.entries.values()].filter((entry) => !entry.completed).length
    if (pending + this.preparing >= 8) throw conflict('Too many model imports are awaiting a destination. Try again shortly.')
    // Completed replies retain no bytes. Keep a separate bounded replay cache,
    // so normal successful use never consumes pending-download capacity.
    const receipts = [...this.entries].filter(([, entry]) => entry.completed)
    for (const [id] of receipts.slice(0, Math.max(0, receipts.length - 127))) this.entries.delete(id)
    this.preparing += 1
    const cancellation = new AbortController()
    this.downloads.add(cancellation)
    const timeout = setTimeout(() => cancellation.abort(new Error('Model download timed out. Import it again.')), LIFETIME_MS)
    timeout.unref()
    try {
      const file = await download(cancellation.signal)
      if (this.closed) {
        await this.removeBytes(file.cleanupPath)
        throw conflict('Model importing is shutting down. Try again shortly.')
      }
      const id = randomUUID()
      const expiresAt = Date.now() + LIFETIME_MS
      this.entries.set(id, { owner, expiresAt, download: file, completed: false })
      return { id, fileName: file.fileName, sizeBytes: file.sizeBytes, expiresAt: new Date(expiresAt).toISOString() }
    } finally {
      clearTimeout(timeout)
      this.downloads.delete(cancellation)
      this.preparing -= 1
    }
  }

  /** Serialize save/cancel/expiry; retries must name exactly the same confirmed destination. */
  async confirm(id: string, owner: string, confirmation: string, save: (file: PreparedDownload) => Promise<T>): Promise<T> {
    return await this.mutex.run(id, async () => {
      const entry = this.owned(id, owner)
      if (entry.confirmation && entry.confirmation !== confirmation) throw conflict('This model was already confirmed for another destination.')
      if (entry.completed) return entry.result!
      entry.confirmation = confirmation
      try {
        const result = await save(entry.download)
        entry.result = result
        entry.completed = true
        return result
      } catch (error) {
        // A failed completion is not replayed automatically: normal persistence
        // owns byte rollback, and the user can explicitly prepare another import.
        this.entries.delete(id)
        throw error
      } finally {
        await this.removeBytes(entry.download.cleanupPath)
      }
    })
  }

  /** Cancellation only discards temporary bytes, never a saved library copy. */
  async cancel(id: string, owner: string): Promise<void> {
    await this.mutex.run(id, async () => {
      const entry = this.owned(id, owner)
      if (entry.confirmation) throw conflict('Saving has begun. This import can no longer be cancelled.')
      this.entries.delete(id)
      await this.removeBytes(entry.download.cleanupPath)
    })
  }

  private owned(id: string, owner: string): Entry<T> {
    const entry = this.entries.get(id)
    if (!entry || entry.owner !== owner) throw notFound('Prepared model not found')
    if (entry.expiresAt <= Date.now()) throw badRequest('This prepared model expired. Import it again.')
    return entry
  }

  private async removeBytes(directory: string): Promise<void> {
    try { await rm(directory, { recursive: true, force: true }) } catch (error) {
      this.warn('Could not remove a prepared model download', error)
    }
  }

  /** Expire entries and reclaim abandoned prepared directories after API restarts. */
  private async sweep(): Promise<void> {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt > Date.now()) continue
      await this.mutex.run(id, async () => {
        this.entries.delete(id)
        await this.removeBytes(entry.download.cleanupPath)
      })
    }
    // A preparation has not published its path yet. Never sweep a live download.
    if (this.preparing > 0) return
    let directories: string[]
    try { directories = await readdir(this.directory) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    const active = new Set([...this.entries.values()].map((entry) => entry.download.cleanupPath))
    for (const name of directories) {
      if (!name.startsWith('prepared-')) continue
      const directory = path.join(this.directory, name)
      if (active.has(directory)) continue
      const info = await stat(directory).catch((error: NodeJS.ErrnoException) => {
        // Another cleanup may already have removed this temporary directory.
        if (error.code !== 'ENOENT') this.warn('Could not inspect a prepared model download', error)
        return null
      })
      if (info && Date.now() - info.mtimeMs > LIFETIME_MS) await this.removeBytes(directory)
    }
  }

  /** Plugin shutdown leaves no retained temporary downloads or sweep timer. */
  async close(): Promise<void> {
    this.closed = true
    for (const download of this.downloads) download.abort(new Error('Model importing is shutting down.'))
    clearInterval(this.timer)
    for (const id of this.entries.keys()) {
      await this.mutex.run(id, async () => {
        const entry = this.entries.get(id)
        this.entries.delete(id)
        if (entry) await this.removeBytes(entry.download.cleanupPath)
      })
    }
  }
}
