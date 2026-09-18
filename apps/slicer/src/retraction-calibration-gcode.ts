/**
 * Applies the calibration plugin's marked retraction sweep to explicit E-axis
 * moves. Only relative extrusion with matched, E-only retract/unretract pairs is
 * supported. Unknown toolpaths fail the slice rather than print misleading bands.
 * Startup/shutdown and all depositing moves are preserved byte-for-byte.
 */
export function applyRetractionCalibration(gcode: string): { gcode: string; pairs: number } {
  if (!gcode.includes('; PRINTSTREAM_RETRACTION_LENGTH=')) return { gcode, pairs: 0 }
  const lines = gcode.split('\n')
  let relative = false
  let active = false
  let ended = false
  let length = 0
  let pairs = 0
  let bandPairs = 0
  let pending: { index: number; original: number; replacement: number | null } | null = null
  const replaceE = (line: string, value: number) => line.replace(/\bE[-+]?\d*\.?\d+/, `E${Number(value.toFixed(5))}`)

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const marker = /^; PRINTSTREAM_RETRACTION_LENGTH=(\d+(?:\.\d+)?)\s*$/.exec(line)
    if (marker) {
      if (ended || !relative) throw new Error('Retraction calibration requires one relative-extrusion test region')
      if (active && bandPairs === 0) throw new Error('A retraction calibration band contains no measurable travel moves')
      length = Number(marker[1])
      if (!Number.isFinite(length) || length < 0 || length > 10) throw new Error('Invalid retraction calibration length')
      active = true
      bandPairs = 0
      continue
    }
    if (line.trim() === '; PRINTSTREAM_RETRACTION_END') {
      if (!active || bandPairs === 0) throw new Error('Incomplete retraction calibration region')
      active = false
      ended = true
      continue
    }
    const code = line.split(';', 1)[0]!.trim()
    if (/^M83\b/.test(code)) relative = true
    if (/^M82\b/.test(code)) {
      relative = false
      if (active || pending?.replacement != null) throw new Error('Absolute extrusion is unsupported in a retraction calibration')
    }
    if (!active && pending?.replacement == null) {
      // The slicer can retract for a layer change just BEFORE the first marker.
      // Track that baseline pair so its restore inside the region stays untouched.
      const previous = /^G[01]\s+E(-\d*\.?\d+)(?:\s+F\d*\.?\d+)?$/.exec(code)
      if (relative && previous) pending = { index, original: -Number(previous[1]), replacement: null }
      else if (/^G[0123]\b.*\bE/.test(code)) pending = null
      continue
    }
    if (/^G92\s+E0(?:\.0+)?$/.test(code)) continue
    if (/^(?:T\d+|G10|G11|G92)\b/.test(code)) throw new Error('Unexpected tool or extrusion reset in retraction calibration')
    if (!/^G[0123]\b/.test(code) || !/\bE/.test(code)) continue
    const extrusion = /\bE([-+]?\d*\.?\d+)/.exec(code)
    if (!extrusion) throw new Error('Invalid extrusion in retraction calibration')
    const value = Number(extrusion[1])
    const pureE = /^G[01]\s+E[-+]?\d*\.?\d+(?:\s+F\d*\.?\d+)?$/.test(code)
    if (value < 0) {
      if (!pureE || pending) throw new Error('Wiping or split retractions are unsupported in calibration')
      pending = { index, original: -value, replacement: length }
    } else if (pending && value > 0) {
      if (!pureE || Math.abs(value - pending.original) > 0.0001) throw new Error('Unpaired retraction or extra restart extrusion in calibration')
      if (pending.replacement != null) {
        lines[pending.index] = replaceE(lines[pending.index]!, -pending.replacement)
        lines[index] = replaceE(line, pending.replacement)
        pairs++
        bandPairs++
      }
      pending = null
    } else if (pureE && value > 0) {
      throw new Error('Unexpected priming move in retraction calibration')
    }
  }
  if (!ended || pairs === 0 || pending?.replacement != null) throw new Error('Incomplete retraction calibration toolpath')
  return { gcode: lines.join('\n'), pairs }
}
