/**
 * Tiny pub/sub for global toast notifications. Lives outside the React
 * tree so non-component code (TanStack Query mutation/query caches, ad-hoc
 * fetch helpers, plugins) can `toast.error('…')` without needing context.
 *
 * The single `<Toaster />` mounted at the app root subscribes to the bus
 * and renders the visible stack.
 */

export type ToastTone = 'danger' | 'warning' | 'success' | 'neutral' | 'primary'
export type ToastDismissReason = 'dismiss' | 'timeout' | 'action'

export interface ToastAction {
  label: string
  onClick: () => void | Promise<void>
}

export interface ToastInput {
  message: string
  /** Defaults to `'danger'` since this is overwhelmingly used for errors. */
  tone?: ToastTone
  /** Auto-dismiss delay in ms. Set to 0 to disable. Defaults to 6000. */
  durationMs?: number
  /** When true, the toast shows an indeterminate in-progress affordance. */
  loading?: boolean
  /**
   * Determinate progress (0-100) rendered as a flat bar under the message.
   * Omit to keep the previous value on update; pass `null` to remove the bar
   * (e.g. when a progress toast turns into its completion summary).
   */
  progress?: number | null
  action?: ToastAction
  onClose?: (reason: ToastDismissReason) => void
}

export interface ToastEntry {
  id: number
  message: string
  tone: ToastTone
  durationMs: number
  loading: boolean
  progress: number | null
  action?: ToastAction
  onClose?: (reason: ToastDismissReason) => void
}

type Listener = (entries: ToastEntry[]) => void

let nextId = 1
const listeners = new Set<Listener>()
let entries: ToastEntry[] = []

function normalizeToastMessage(message: string, fallback = 'Something went wrong'): string {
  return message.trim() || fallback
}

function emit(): void {
  const snapshot = [...entries]
  for (const listener of listeners) listener(snapshot)
}

function normalizeToastInput(input: ToastInput | string): ToastInput {
  return typeof input === 'string' ? { message: input } : input
}

function buildEntry(id: number, input: ToastInput, previous?: ToastEntry): ToastEntry {
  const tone = input.tone ?? previous?.tone ?? 'danger'
  return {
    id,
    message: normalizeToastMessage(input.message, tone === 'danger' ? 'Something went wrong' : ''),
    tone,
    durationMs: input.durationMs ?? previous?.durationMs ?? 6000,
    loading: input.loading ?? previous?.loading ?? false,
    progress: input.progress === undefined ? previous?.progress ?? null : input.progress,
    action: input.action ?? previous?.action,
    onClose: input.onClose ?? previous?.onClose
  }
}

export const toast = {
  /** Subscribe to incoming toasts. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    listeners.add(listener)
    listener([...entries])
    return () => listeners.delete(listener)
  },
  show(input: ToastInput | string): number {
    const normalized = normalizeToastInput(input)
    const entry = buildEntry(nextId++, normalized)
    entries = [...entries, entry]
    emit()
    return entry.id
  },
  update(id: number, input: ToastInput | string): void {
    const normalized = normalizeToastInput(input)
    entries = entries.map((entry) => (entry.id === id ? buildEntry(id, normalized, entry) : entry))
    emit()
  },
  dismiss(id: number, reason: ToastDismissReason = 'dismiss'): void {
    const dismissed = entries.find((entry) => entry.id === id)
    if (!dismissed) return
    entries = entries.filter((entry) => entry.id !== id)
    dismissed.onClose?.(reason)
    emit()
  },
  clear(): void {
    if (entries.length === 0) return
    const cleared = [...entries]
    entries = []
    for (const entry of cleared) entry.onClose?.('dismiss')
    emit()
  },
  loading(input: ToastInput | string): number {
    if (typeof input === 'string') return toast.show({ message: input, tone: 'neutral', durationMs: 0, loading: true })
    return toast.show({ ...input, tone: input.tone ?? 'neutral', durationMs: input.durationMs ?? 0, loading: true })
  },
  /** Convenience for the common danger case. Accepts a string or full input. */
  error(input: ToastInput | string): number {
    if (typeof input === 'string') return toast.show({ message: input, tone: 'danger' })
    return toast.show({ ...input, tone: input.tone ?? 'danger' })
  },
  success(input: ToastInput | string): number {
    if (typeof input === 'string') return toast.show({ message: input, tone: 'success' })
    return toast.show({ ...input, tone: input.tone ?? 'success' })
  },
  info(input: ToastInput | string): number {
    if (typeof input === 'string') return toast.show({ message: input, tone: 'neutral' })
    return toast.show({ ...input, tone: input.tone ?? 'neutral' })
  },
  warn(input: ToastInput | string): number {
    if (typeof input === 'string') return toast.show({ message: input, tone: 'warning' })
    return toast.show({ ...input, tone: input.tone ?? 'warning' })
  }
}
