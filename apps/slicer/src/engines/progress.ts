/**
 * In-flight engine installs, so a caller never holds a request open for one.
 *
 * An engine is 220-470 MB compressed and unpacks to over a gigabyte. On a fast
 * link that is seconds; on a slow one it is many minutes. Either way a
 * synchronous request is the wrong shape, it ties the outcome to a socket
 * staying up, and a wedged download becomes a caller waiting on a timeout long
 * enough that they assume the app is broken.
 *
 * So `POST /engines/:id/install` starts the work and answers immediately, and
 * this is where the answer to "how is it going" lives. Same shape as slicing
 * jobs, which solved this already.
 *
 * Deliberately in memory. A restart loses the record, which is correct: the
 * install died with the process, and the manifest, written only on success,
 * is the durable truth about what is actually installed.
 */
export type EngineInstallState = 'installing' | 'failed'

export interface EngineInstallStatus {
  state: EngineInstallState
  /** 0-1 while downloading; absent for phases with no measurable total. */
  fraction?: number
  label: string
  error?: string
  startedAt: number
}

const inFlight = new Map<string, EngineInstallStatus>()

export function beginInstall(id: string): void {
  inFlight.set(id, { state: 'installing', label: 'Starting', startedAt: Date.now() })
}

export function reportInstall(id: string, label: string, fraction?: number): void {
  const current = inFlight.get(id)
  if (!current || current.state !== 'installing') return
  inFlight.set(id, { ...current, label, fraction })
}

/** Clears the record: the manifest now says what happened. */
export function finishInstall(id: string): void {
  inFlight.delete(id)
}

/**
 * Kept, not cleared, so the UI can say WHY rather than silently reverting to
 * "not installed", which reads as the click having done nothing.
 */
export function failInstall(id: string, error: string): void {
  const current = inFlight.get(id)
  inFlight.set(id, {
    state: 'failed',
    label: 'Install failed',
    error,
    startedAt: current?.startedAt ?? Date.now()
  })
}

export function installStatus(id: string): EngineInstallStatus | null {
  return inFlight.get(id) ?? null
}

/**
 * Whatever install is in flight, for callers that do not know an engine id.
 *
 * The health payload needs this: someone waiting to slice on a fresh container
 * is waiting on "the engine", and asking them to know which one is asking them
 * to know something only the catalogue does. At most one install runs at a
 * time, so the first entry is the answer.
 */
export function anyInstallStatus(): (EngineInstallStatus & { id: string }) | null {
  for (const [id, status] of inFlight) {
    if (status.state === 'installing') return { ...status, id }
  }
  return null
}

/** Whether an install is already running, so a second click does not start one. */
export function isInstalling(id: string): boolean {
  return inFlight.get(id)?.state === 'installing'
}
