/**
 * What the engine-log disclosure shows, as a pure function of a job's output.
 *
 * Split from `components/SlicingEngineLog.tsx` because that component renders `@mui/icons-material`
 * icons and so cannot be render-tested here (see the web development notes); the two decisions worth
 * pinning are both decisions about data, not layout.
 */
import type { SlicingOutputLine } from '@printstream/shared'

/** Default cap on RENDERED lines. See {@link selectEngineLogLines} for why there is one. */
export const DEFAULT_ENGINE_LOG_TAIL = 400

export interface EngineLogSelection {
  /** The trailing lines to render, oldest first. */
  shown: SlicingOutputLine[]
  /** How many engine lines were left out of {@link shown}. Zero when the whole log is rendered. */
  hidden: number
  /** Every engine line, for copying. Never truncated. */
  all: SlicingOutputLine[]
}

/**
 * The engine's own lines (`stdout`/`stderr`), with a rendered tail and an explicit count of what the
 * tail left out.
 *
 * `system` lines are excluded because they are OURS, not the engine's: they are the job's
 * user-facing status and are already rendered above the disclosure, so including them here would
 * show the same sentence twice and pad the log with text the engine never wrote.
 *
 * The cap is on rendering only. The server retains up to 5000 lines and a real slice fills them,
 * which is more DOM than a dialog should mount, and a failure is always at the END of the log.
 * `all` stays complete so a copy is a complete copy: a truncated bug report is worse than none.
 */
export function selectEngineLogLines(
  output: readonly SlicingOutputLine[] | undefined,
  max: number = DEFAULT_ENGINE_LOG_TAIL
): EngineLogSelection {
  const all = (output ?? []).filter((line) => line.stream === 'stdout' || line.stream === 'stderr')
  const shown = max >= 0 && all.length > max ? all.slice(all.length - max) : [...all]
  return { shown, hidden: all.length - shown.length, all }
}
