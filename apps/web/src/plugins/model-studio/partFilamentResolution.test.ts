/**
 * A part's filament must never be resolved to a COLOUR without its inheritance rule.
 *
 * `EditorInstancePart.filamentId` is tri-state: a number is an explicit choice, null means "not
 * chosen", and the bake resolves null to the OBJECT's material
 * (`toExtruder(partFilaments?.get(i) ?? null) ?? objectExtruder`). `resolveColorFilamentId` does
 * something different and easily confused with it: its fallback exists to recolour a DANGLING id, a
 * material the user removed, so it answers with the project's FIRST material for anything it does
 * not recognise, null included.
 *
 * Passing a bare `part.filamentId` therefore paints every unassigned part in material 1. That is
 * not hypothetical: it shipped in four separate call sites in this plugin, and the last one was the
 * worst, because the material-sync effect runs at the end of EVERY plate build and so overwrote the
 * colour the build had just computed correctly. The symptom is a replaced object reading as
 * material 5 in the sidebar and rendering as material 1 in the viewport.
 *
 * Nothing in the type system can catch it: both forms are `number | null`. So the rule is checked
 * as source. A call site satisfies it by going through `effectivePartFilamentId` (which also drops
 * the material for helper volumes, as BambuStudio does) or by writing the inheritance explicitly as
 * `?? instance.filamentId`. A line that genuinely resolves something else opts out with
 * `part-filament-ok`.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Files that turn a part's filament into a rendered or displayed colour. */
const SOURCES = ['EditorView.tsx', 'editorPanels.tsx']

test('every part filament resolved to a colour carries the object-inheritance rule', () => {
  const offenders: string[] = []
  for (const file of SOURCES) {
    const lines = readFileSync(path.join(here, file), 'utf8').split('\n')
    lines.forEach((line, index) => {
      // Prose about the rule (including this file's own reasoning) is not a call site.
      if (/^\s*(\/\/|\/\*|\*)/.test(line)) return
      // Only the calls that turn an id into a colour, not the resolver's own declaration.
      if (!/resolveColorFilamentId|resolveId\(/.test(line)) return
      if (/useRef|useCallback|^\s*const resolveColorFilamentId\s*=/.test(line)) return
      // A WINDOW, not the line: the argument is routinely wrapped onto the next line, and a
      // line-only rule cannot see `resolveColorFilamentIdRef.current(\n  part ? ... )`. That is not
      // hypothetical, it is how the call this rule exists to protect is actually formatted.
      // Comments are stripped first, or a neighbouring one that happens to say "part" reads as an
      // argument.
      const window = lines.slice(index, index + 3)
        .map((entry) => entry.replace(/\/\/.*$/, ''))
        .join(' ')
      // Only the ones fed from a PART; an instance-level resolution is already the object's own.
      if (!/\bpart\b/.test(window)) return
      if (window.includes('part-filament-ok')) return
      const inherits = window.includes('effectivePartFilamentId')
        || /\?\?\s*instance\.filamentId/.test(window)
      if (!inherits) offenders.push(`${file}:${index + 1}  ${line.trim()}`)
    })
  }

  assert.deepEqual(
    offenders,
    [],
    'a part filament was resolved to a colour without its inheritance rule; an unassigned part would\n'
      + 'render in the project\'s FIRST material. Use effectivePartFilamentId(part, instance.filamentId):\n  '
      + offenders.join('\n  ')
  )
})
