/**
 * Every Bambu Studio build this slicer can run must be classified for the by-object linked-copy
 * defects (`@printstream/shared/three-mf` `by-object-linked-copies.ts`): either listed as having
 * them, or listed as verified unaffected.
 *
 * The warning deliberately says nothing for an unverified engine, so without this test vendoring
 * a newer build would silently switch the warning off for it, whether or not it still has the
 * bug. Verify the new tag's `GCode.cpp` / `Print.hpp` / `PrintApply.cpp` (see the module header)
 * and add it to the right list.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BY_OBJECT_LINKED_COPY_DEFECT_VERSIONS,
  BY_OBJECT_LINKED_COPY_UNAFFECTED_VERSIONS
} from '@printstream/shared/three-mf'
import { slicerTargets } from '../../docker/slicer-targets.mjs'

test('every shipped Bambu Studio build is classified for the by-object linked-copy defects', () => {
  const classified = new Set([
    ...BY_OBJECT_LINKED_COPY_DEFECT_VERSIONS.printsTogether,
    ...BY_OBJECT_LINKED_COPY_DEFECT_VERSIONS.copiesDropped,
    ...BY_OBJECT_LINKED_COPY_UNAFFECTED_VERSIONS
  ])

  const unclassified = slicerTargets
    .filter((target) => target.family === 'bambustudio')
    .map((target) => target.version)
    .filter((version) => !classified.has(version))

  assert.deepEqual(unclassified, [], `Classify these Bambu Studio builds in by-object-linked-copies.ts: ${unclassified.join(', ')}`)
})
