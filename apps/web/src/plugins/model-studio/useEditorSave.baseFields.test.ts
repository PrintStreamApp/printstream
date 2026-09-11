/**
 * Build guard: every bake request the editor sends names its base bytes as ONE value.
 *
 * `baseFileId`, `baseVersionId` and `contentBase` are a set. The first two say which file is being
 * written; the pin says which BYTES to author from. A request carrying the identity without the pin
 * used to bake from the target's CURRENT content, which after this session's first save is this
 * session's own output, so the edit was re-applied over itself. `partOrder` and `removedParts` are
 * not idempotent under that, and a re-applied reorder permutes an object's volumes while the
 * positional per-part extruder writes stay put: parts trade materials and a two-colour plate prints
 * inverted, with nothing logged.
 *
 * Both single-object exports shipped in exactly that state, for the ordinary reason that the fields
 * were spelled out per call site and two of the four sites were written without the pin. The API
 * now refuses such a request outright (`routes/editor.ts`, and `editor-content-base.test.ts` pins
 * that), so this guard is the other half: it keeps the web from being able to send one at all.
 *
 * Deliberately a SOURCE scan rather than a hook test, matching `BackAwareModal.test.ts` and
 * `AppThemeProvider.test.ts`. What matters is that no future call site can reintroduce the split,
 * and that is a property of how the file is written, not of one render.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const source = readFileSync(fileURLToPath(new URL('./useEditorSave.ts', import.meta.url)), 'utf8')

/** The one place the fields may be named together, which every request then spreads. */
const DEFINITION = 'const baseBakeFields = useMemo'

test('the base fields are assembled in exactly one place', () => {
  const definitions = source.split(DEFINITION).length - 1
  assert.equal(definitions, 1, 'expected a single baseBakeFields definition')
})

test('no request literal spells the base fields out for itself', () => {
  // Only the definition may assign them. Anywhere else is a call site building its own combination,
  // which is how a payload ends up with the identity and no pin.
  const definitionIndex = source.indexOf(DEFINITION)
  assert.ok(definitionIndex > 0, 'the definition moved; update this guard')
  const definitionEnd = source.indexOf('}), [', definitionIndex)
  const outsideDefinition = source.slice(0, definitionIndex) + source.slice(definitionEnd)

  for (const field of ['baseFileId:', 'baseVersionId:']) {
    const offenders = outsideDefinition
      .split('\n')
      .map((line, index) => ({ line: line.trim(), number: index + 1 }))
      // The hook's own props interface has to declare them; only VALUE assignments are the problem,
      // and a declaration is followed by a type rather than an expression.
      .filter((entry) => entry.line.includes(field))
      .filter((entry) => !/^\*|^\/\//.test(entry.line))
      .filter((entry) => !/:\s*(string|EditorContentBasePin)\b/.test(entry.line))
    assert.deepEqual(offenders, [], `${field} is assigned outside baseBakeFields`)
  }
})

test('every bake request spreads the assembled fields', () => {
  // Save, save-as, export-to-library and export-download. Four is not incidental: it is every path
  // that reaches a bake, and a fifth added without the spread is what this catches.
  const spreads = source.split('...baseBakeFields').length - 1
  assert.equal(spreads, 4, `expected 4 bake requests to spread the base fields, found ${spreads}`)
})

test('prepared slicing keeps source lineage separate from the pinned configuration base', () => {
  // After Save As, effectiveBaseFileId is the newly adopted project while contentBase remains the
  // original archive this session opened. Collapsing these identities makes that valid slice fail
  // server proof validation or attributes it to the wrong library project.
  assert.match(source, /const sourceFileId = effectiveBaseFileId/)
  assert.match(source, /const configurationBaseFileId = contentBase\?\.fileId \?\? effectiveBaseFileId/)
  assert.match(source, /stageSnapshot\(\{\s*sceneEdit: edit,\s*sourceFileId,/)
  assert.match(source, /configurationBaseFileId,/)
})
