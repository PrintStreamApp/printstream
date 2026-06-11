/**
 * Detect printer end-G-code patterns that park the head before a final bed drop.
 *
 * Some Bambu slicer profiles end with a long cleanup block: the toolhead parks,
 * heaters and fans shut down, optional timelapse/AMS cleanup runs, and only then
 * the printer performs a large Z move down to its terminal resting position.
 *
 * When this pattern is present, a `job.finished`-time snapshot is often too late.
 */

export interface PrintFinishGcodeAnalysis {
  hasTerminalParkedBedDrop: boolean
}

export function analyzePrintFinishGcode(gcode: string): PrintFinishGcodeAnalysis {
  const lines = gcode.split(/\r?\n/)
  const endBlockStart = lines.findIndex((line) => line.includes('MACHINE_END_GCODE_START'))
  if (endBlockStart < 0) {
    return { hasTerminalParkedBedDrop: false }
  }

  const terminalDropIndex = findTerminalBedDropIndex(lines, endBlockStart)
  if (terminalDropIndex < 0) {
    return { hasTerminalParkedBedDrop: false }
  }

  const parkedMoveIndex = findParkedMoveIndex(lines, endBlockStart, terminalDropIndex)
  return {
    hasTerminalParkedBedDrop: parkedMoveIndex >= 0
  }
}

function findTerminalBedDropIndex(lines: string[], endBlockStart: number): number {
  let lastReducedZCurrentIndex = -1

  for (let index = endBlockStart; index < lines.length; index += 1) {
    const code = stripComment(lines[index])
    if (!code) continue
    if (/^M17\s+Z[-+]?\d*\.?\d+/i.test(code)) {
      lastReducedZCurrentIndex = index
    }
  }

  if (lastReducedZCurrentIndex < 0) return -1

  for (let index = lastReducedZCurrentIndex + 1; index < lines.length; index += 1) {
    const code = stripComment(lines[index])
    if (!code) continue
    if (isTerminalBedDropMove(code)) return index
  }

  return -1
}

function findParkedMoveIndex(lines: string[], endBlockStart: number, terminalDropIndex: number): number {
  for (let index = terminalDropIndex - 1; index >= endBlockStart; index -= 1) {
    const code = stripComment(lines[index])
    if (!code) continue
    if (isLikelyParkMove(code)) return index
  }

  return -1
}

function isTerminalBedDropMove(code: string): boolean {
  if (!/^G[01]\b/i.test(code)) return false

  const params = parseGcodeParams(code)
  if (params.Z == null) return false
  if (params.F == null || params.F > 900) return false
  return params.X == null && params.Y == null && params.E == null
}

function isLikelyParkMove(code: string): boolean {
  if (/^G150\.3\b/i.test(code)) return true
  if (!/^G[01]\b/i.test(code)) return false

  const params = parseGcodeParams(code)
  if (params.X == null && params.Y == null) return false
  if (params.E != null && params.E > 0) return false
  return true
}

function stripComment(line: string | undefined): string {
  return line?.split(';', 1)[0]?.trim() ?? ''
}

function parseGcodeParams(line: string): Record<string, number> {
  const params: Record<string, number> = {}
  for (const match of line.matchAll(/\b([A-Z])([-+]?\d*\.?\d+)\b/g)) {
    const key = match[1]
    const value = Number.parseFloat(match[2] ?? '')
    if (!key || !Number.isFinite(value)) continue
    params[key] = value
  }
  return params
}