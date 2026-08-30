import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/**
 * `different_settings_to_system` and `inherits_group` are written in ONE module.
 *
 * The two arrays are BambuStudio's parallel preset records, `[process, ...one per filament,
 * machine]`, and every hand-rolled writer of them has eventually got the machine slot wrong. Three
 * did, independently, before this test existed: a user's project-local printer override was written
 * into a FILAMENT slot and vanished on reopen; `clearInheritsGroupSlot` blanked whatever entry sat
 * last, so a long record kept the stale machine parent it exists to clear and a short one told the
 * CLI a filament was a system preset; and a resize read the machine entry off the source array's
 * own length while resizing it.
 *
 * They share one failure shape, which is why they share a guard rather than three fixes: the slot
 * is `filament_count + 1` and the engine takes it from the FILAMENT COUNT, resizing the two arrays
 * INDEPENDENTLY of each other (`BambuStudio.cpp:3200-3215`, `PresetBundle.cpp:1383,3885`). Anything
 * derived from an array's `length` agrees only while that array is correctly sized -- and a
 * mis-sized record is exactly the input these paths have to survive, since the Repair stage fixes
 * `inherits_group` and deliberately leaves its twin alone.
 *
 * Nothing about a wrong slot throws, logs, or fails to load: the file saves, reopens, and reads as
 * though the user never made the change. So the check is a build failure rather than a convention.
 *
 * What it does NOT catch: a writer that calls the shared helpers with a wrong index, and a fixture
 * or assertion in a test file (both scans skip `.test.ts`, where writing these arrays directly IS
 * the point). It catches a NEW hand-rolled writer, which is how all three arrived.
 */
const SRC = fileURLToPath(new URL('.', import.meta.url))
const REPO_ROOT = join(SRC, '..', '..', '..')

/** The module that owns the layout: the helpers, the slot index, and their documentation. */
const OWNER = 'packages/shared/src/three-mf-project-config.ts'

/**
 * Files allowed to assign either array, each of which goes through {@link OWNER}'s helpers.
 *
 * Adding a file here is a deliberate act: read the owner's header first, take `machinePresetSlotIndex`
 * for the machine slot, and state in a comment where your filament count comes from -- the record's
 * own identity arrays when it still has them, the array's width when (as in the binding pass) the
 * record has already been rewritten to a new count.
 */
const ALLOWED_WRITERS = new Set([
  OWNER,
  'packages/shared/src/machine-retarget.ts',
  'packages/shared/src/filament-rebind.ts',
  'packages/shared/src/filament-preset-binding.ts',
  'packages/shared/src/three-mf/bake-documents.ts',
  // The repair stage: it owns the SIZE of `inherits_group`, which is the one defect the writers
  // above deliberately decline to heal during an ordinary save.
  'packages/shared/src/repairs/inherits-group.ts',
  // Blanks slot 0 (the process parent) when dropping an incompatible process preset. Slot 0 is the
  // one index in either array that no count arithmetic can get wrong.
  'apps/api/src/lib/slicing-jobs.ts'
])

const SCAN_ROOTS = [
  'packages/shared/src',
  'packages/bridge-runtime/src',
  'apps/api/src',
  'apps/web/src',
  'apps/bridge/src',
  'apps/slicer/src'
]

/**
 * `compatible_machine_expression_group` has the same layout and the same `num_filaments + 2` resize
 * (`PresetBundle.cpp:3748-3751`). Nothing writes it today, which is exactly why it is listed: the
 * first writer should arrive through the shared helpers rather than rediscovering the slot
 * arithmetic a fourth time.
 */
const RECORD_NAMES = ['different_settings_to_system', 'inherits_group', 'compatible_machine_expression_group']

/**
 * An assignment TO either array, in every shape a writer actually uses:
 * `record.inherits_group =`, `next['inherits_group'] =`, and the OBJECT-LITERAL form
 * `{ ...record, inherits_group: rebuilt }`, which `bake-documents.ts` itself would have used and
 * which a property-syntax-only scan cannot see.
 */
const ASSIGNMENT = new RegExp(
  `(?:\\.|\\['|\\[")(${RECORD_NAMES.join('|')})(?:'\\]|"\\])?\\s*=(?!=)` +
  `|(?:^|[,{(\\s])(${RECORD_NAMES.join('|')})\\s*:(?!\\s*(?:z\\.|string|number|boolean|unknown|readonly|Array|\\{))`,
  'm'
)

/**
 * Reading a record's machine entry as its own LAST element: `group[group.length - 1]`.
 *
 * Matched on the IDENTIFIER, because the bug was written through a named local every time and never
 * through the record's own name: the four found so far were `inheritsGroup`, `differentSettings`,
 * `current` and `group`. Ordinary `xs[xs.length - 1]` on an unrelated array is left alone, which is
 * what keeps this from becoming a warning nobody reads.
 */
const RECORD_ALIASES = ['different_settings_to_system', 'inherits_group', 'differentSettings', 'inheritsGroup', 'current', 'group']
const LENGTH_DERIVED_SLOT = new RegExp(
  `\\b(?:${RECORD_ALIASES.join('|')})\\s*\\[\\s*[\\w.]*length\\s*-\\s*1\\s*\\]`
)

/**
 * Files where `length - 1` is CORRECT, each for a stated reason. Anything else must locate the
 * machine slot with `machinePresetSlotIndexFor`.
 */
const LENGTH_DERIVED_SLOT_EXEMPT = new Set([
  // The repair, whose whole premise is an array of the WRONG width: `filament_count + 1` is
  // meaningless there, so the array's own end is the only evidence of where its author put the
  // machine entry. See the comment at the assignment.
  'packages/shared/src/repairs/inherits-group.ts'
])

function walk(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  return entries.flatMap((entry) => {
    const full = join(dir, entry)
    if (entry === 'node_modules' || entry === 'dist' || entry === 'generated') return []
    if (statSync(full).isDirectory()) return walk(full)
    return (full.endsWith('.ts') || full.endsWith('.tsx')) && !full.endsWith('.test.ts') && !full.endsWith('.test.tsx')
      ? [full]
      : []
  })
}

function sourceFiles(): Array<{ path: string; source: string }> {
  return SCAN_ROOTS.flatMap((root) => walk(join(REPO_ROOT, root))).map((file) => ({
    path: file.slice(REPO_ROOT.length + 1),
    source: readFileSync(file, 'utf8')
  }))
}

test('only the owning module and its documented callers write the parallel preset records', () => {
  const offenders = sourceFiles()
    .filter(({ source }) => ASSIGNMENT.test(source))
    .map(({ path }) => path)
    .filter((path) => !ALLOWED_WRITERS.has(path))
  assert.deepEqual(offenders, [],
    `These files assign \`different_settings_to_system\` or \`inherits_group\` directly. Both are ` +
    `\`[process, ...filaments, machine]\` and the machine slot is \`filament_count + 1\`, never the ` +
    `array's last entry. Go through the helpers in ${OWNER} (\`machinePresetSlotIndex\`, ` +
    `\`withChangedFromSystemSlot\`, \`withParallelPresetSlot\`, \`resizeParallelPresetRecord\`) and ` +
    `add the file to ALLOWED_WRITERS:\n${offenders.join('\n')}`)
})

test('no module derives a preset record slot from the array length', () => {
  // Scoped to files that touch these records at all: `length - 1` is ordinary array arithmetic
  // everywhere else in the repo and only means "the machine slot" here.
  const touchesRecord = new RegExp(RECORD_NAMES.join('|'))
  const offenders = sourceFiles()
    .filter(({ path }) => path !== OWNER && !LENGTH_DERIVED_SLOT_EXEMPT.has(path))
    .filter(({ source }) => touchesRecord.test(source) && LENGTH_DERIVED_SLOT.test(source))
    .map(({ path }) => path)
  assert.deepEqual(offenders, [],
    `These files index a parallel preset record at \`length - 1\`. That is the machine slot only ` +
    `while the array is correctly sized, and a mis-sized one is what the Repair stage routinely ` +
    `leaves behind. Use \`machinePresetSlotIndex(filamentSlotCount(record))\`:\n${offenders.join('\n')}`)
})

test('the owning module still exports the helpers this guard points callers at', async () => {
  // A rename that orphaned them would leave the failure messages above naming nothing, and the
  // scans would keep passing because no new writer had appeared.
  const owner = await import('./three-mf-project-config.js')
  for (const name of ['machinePresetSlotIndex', 'withChangedFromSystemSlot', 'withParallelPresetSlot', 'resizeParallelPresetRecord', 'filamentSlotCount']) {
    assert.equal(typeof (owner as Record<string, unknown>)[name], 'function', `${OWNER} must export ${name}`)
  }
})
