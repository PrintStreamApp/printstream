/**
 * Stale sliced-result nozzle groups (see stale-slice-info.ts). A single `group_id` left over from
 * an older BambuStudio slice used to segfault the CLI at load (exit 139) before any geometry was
 * read: reproduced on a real project on both an H2D and an A1 mini.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sliceInfoCarriesNozzleGroupIds, stripSliceInfoNozzleGroupIds } from './stale-slice-info.js'

/** Verbatim shape BambuStudio 1.10 wrote: a group id, and none of the newer nozzle attributes. */
const STALE_SLICE_INFO = `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Version" value="01.10.01.50"/>
  </header>
  <plate>
    <metadata key="index" value="1"/>
    <metadata key="prediction" value="9599"/>
    <object identify_id="331" name="Stand 14mm.stl" skipped="false" />
    <filament id="1" tray_info_idx="GFL99" type="PLA" color="#FFFFFF" used_m="30.16" used_g="89.95"  group_id="0"/>
  </plate>
</config>`

test('a group id left by a previous slice is detected and removed, and nothing else changes', () => {
  assert.equal(sliceInfoCarriesNozzleGroupIds(STALE_SLICE_INFO), true)
  const stripped = stripSliceInfoNozzleGroupIds(STALE_SLICE_INFO)
  assert.equal(sliceInfoCarriesNozzleGroupIds(stripped), false)
  assert.ok(!stripped.includes('group_id'))
  // The filament ENTRY must survive: the CLI's arrange path reads the plate's filament count off
  // `slice_filaments_info.size()`, so dropping the element would change how it sizes the tower.
  assert.match(stripped, /<filament id="1" tray_info_idx="GFL99" type="PLA" color="#FFFFFF" used_m="30\.16" used_g="89\.95"\s*\/>/)
  assert.ok(stripped.includes('<object identify_id="331" name="Stand 14mm.stl" skipped="false" />'))
  assert.ok(stripped.includes('<metadata key="prediction" value="9599"/>'))
})

test('every filament is cleared, not just the first', () => {
  const multi = `<config><plate>`
    + `<filament id="1" type="PLA" group_id="0"/>`
    + `<filament id="2" type="PETG" group_id="1"/>`
    + `<filament id="3" type="PLA" group_id="0"/>`
    + `</plate></config>`
  const stripped = stripSliceInfoNozzleGroupIds(multi)
  assert.equal(sliceInfoCarriesNozzleGroupIds(stripped), false)
  assert.equal(stripped.match(/<filament /g)?.length, 3)
})

test('a document with nothing to strip is left byte-identical and reports clean', () => {
  // What BambuStudio 2.x writes for a project it has not sliced: the known-good control file.
  const headerOnly = '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n'
    + '    <header_item key="X-BBL-Client-Version" value="02.05.00.66"/>\n  </header>\n</config>'
  assert.equal(sliceInfoCarriesNozzleGroupIds(headerOnly), false)
  assert.equal(stripSliceInfoNozzleGroupIds(headerOnly), headerOnly)

  const modernNoGroups = '<config><plate><filament id="1" type="PLA" nozzle_volume_type="Standard"/></plate></config>'
  assert.equal(sliceInfoCarriesNozzleGroupIds(modernNoGroups), false)
  assert.equal(stripSliceInfoNozzleGroupIds(modernNoGroups), modernNoGroups)

  assert.equal(sliceInfoCarriesNozzleGroupIds(''), false)
  assert.equal(stripSliceInfoNozzleGroupIds(''), '')
})

test('a group_id outside a filament element is left alone', () => {
  // Only `<filament>` feeds BambuStudio's nozzle-group inference; a like-named attribute
  // elsewhere is not ours to rewrite.
  const other = '<config><plate><metadata key="group_id" value="0"/><filament id="1" group_id="0"/></plate></config>'
  const stripped = stripSliceInfoNozzleGroupIds(other)
  assert.ok(stripped.includes('<metadata key="group_id" value="0"/>'))
  assert.ok(stripped.includes('<filament id="1"/>'))
})
