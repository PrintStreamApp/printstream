import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlicingProfileSummary } from '@printstream/shared'
import {
  SLICING_PROFILE_FACETS,
  collectSlicingProfileFacetOptions,
  countActiveSlicingProfileFacets,
  filterSlicingProfilesForKind,
  findSlicingProfileFacet,
  groupSlicingProfilesByFacet
} from './slicingProfileFacets'

/** Facet lookup that fails the test loudly rather than typing as possibly-undefined. */
function facet(kind: Parameters<typeof findSlicingProfileFacet>[0], facetId: string) {
  const found = findSlicingProfileFacet(kind, facetId)
  assert.ok(found, `no ${facetId} facet for ${kind}`)
  return found
}

function profile(overrides: Partial<SlicingProfileSummary> & Pick<SlicingProfileSummary, 'id' | 'kind' | 'name'>): SlicingProfileSummary {
  return { source: 'custom', ...overrides }
}

const MACHINES: SlicingProfileSummary[] = [
  profile({ id: 'm1', kind: 'machine', name: 'H2D 0.4', printerModels: ['Bambu Lab H2D'], nozzleDiameters: [0.4] }),
  profile({ id: 'm2', kind: 'machine', name: 'X1C 0.6', printerModels: ['Bambu Lab X1 Carbon'], nozzleDiameters: [0.6] })
]

const PROCESSES: SlicingProfileSummary[] = [
  profile({ id: 'p1', kind: 'process', name: '0.20mm Standard @BBL X1C', compatiblePrinters: ['Bambu Lab X1 Carbon 0.4 nozzle'] }),
  profile({ id: 'p2', kind: 'process', name: '0.08mm Extra Fine @BBL X1C', compatiblePrinters: ['Bambu Lab X1 Carbon 0.4 nozzle'] })
]

const FILAMENTS: SlicingProfileSummary[] = [
  profile({ id: 'f1', kind: 'filament', name: 'My PLA', filamentType: 'PLA', filamentVendor: 'Polymaker' }),
  profile({ id: 'f2', kind: 'filament', name: 'My PETG', filamentType: 'PETG', filamentVendor: 'Bambu Lab' })
]

const ALL = [...MACHINES, ...PROCESSES, ...FILAMENTS]

test('each tab sees only its own kind', () => {
  assert.deepEqual(filterSlicingProfilesForKind(ALL, 'machine', '', {}).map((entry) => entry.id), ['m1', 'm2'])
  assert.deepEqual(filterSlicingProfilesForKind(ALL, 'filament', '', {}).map((entry) => entry.id), ['f1', 'f2'])
})

test('facet options list only values that are actually present', () => {
  const options = collectSlicingProfileFacetOptions(MACHINES, SLICING_PROFILE_FACETS.machine)
  assert.deepEqual(options.printerModel, ['Bambu Lab H2D', 'Bambu Lab X1 Carbon'])
  // Nozzle diameters carry their unit so the option reads as a size, not a bare number.
  assert.deepEqual(options.nozzle, ['0.4 mm', '0.6 mm'])
})

test('values within one facet combine with OR', () => {
  const matched = filterSlicingProfilesForKind(MACHINES, 'machine', '', { nozzle: ['0.4 mm', '0.6 mm'] })
  assert.deepEqual(matched.map((entry) => entry.id), ['m1', 'm2'])
})

test('separate facets combine with AND', () => {
  const none = filterSlicingProfilesForKind(MACHINES, 'machine', '', {
    printerModel: ['Bambu Lab H2D'],
    nozzle: ['0.6 mm']
  })
  assert.deepEqual(none, [])
})

test('process layer height comes from the preset name', () => {
  const options = collectSlicingProfileFacetOptions(PROCESSES, SLICING_PROFILE_FACETS.process)
  assert.deepEqual(options.layerHeight, ['0.08mm', '0.20mm'])
  const fine = filterSlicingProfilesForKind(PROCESSES, 'process', '', { layerHeight: ['0.08mm'] })
  assert.deepEqual(fine.map((entry) => entry.id), ['p2'])
})

test('filament facets filter by material and brand', () => {
  const petg = filterSlicingProfilesForKind(FILAMENTS, 'filament', '', { filamentType: ['PETG'] })
  assert.deepEqual(petg.map((entry) => entry.id), ['f2'])
})

test('search narrows within the active kind', () => {
  const matched = filterSlicingProfilesForKind(ALL, 'filament', 'petg', {})
  assert.deepEqual(matched.map((entry) => entry.id), ['f2'])
})

test('grouping buckets by a facet value, sorted', () => {
  const groups = groupSlicingProfilesByFacet(FILAMENTS, facet('filament', 'filamentType'))
  assert.deepEqual(groups.map((group) => [group.label, group.profiles.length]), [['PETG', 1], ['PLA', 1]])
})

// A quality preset compatible with several printers belongs under each of them — that is the
// point of grouping by compatible printer, so the groups deliberately do not partition the list.
test('a profile with several values appears in every matching group', () => {
  const multi = profile({
    id: 'p3',
    kind: 'process',
    name: '0.16mm @BBL',
    compatiblePrinters: ['Bambu Lab X1 Carbon 0.4 nozzle', 'Bambu Lab P1S 0.4 nozzle']
  })
  const groups = groupSlicingProfilesByFacet([multi], facet('process', 'compatiblePrinter'))
  assert.deepEqual(groups.map((group) => group.label), ['Bambu Lab P1S 0.4 nozzle', 'Bambu Lab X1 Carbon 0.4 nozzle'])
  assert.ok(groups.every((group) => group.profiles[0]?.id === 'p3'))
})

test('profiles missing the grouped value fall into a bucket sorted last', () => {
  const noVendor = profile({ id: 'f3', kind: 'filament', name: 'Mystery', filamentType: 'PLA' })
  const groups = groupSlicingProfilesByFacet([noVendor, ...FILAMENTS], facet('filament', 'filamentVendor'))
  assert.deepEqual(groups.map((group) => group.label), ['Bambu Lab', 'Polymaker', 'Unspecified'])
})

test('the active-filter count ignores facets with nothing selected', () => {
  assert.equal(countActiveSlicingProfileFacets({}), 0)
  assert.equal(countActiveSlicingProfileFacets({ nozzle: [], printerModel: ['Bambu Lab H2D'] }), 1)
  assert.equal(countActiveSlicingProfileFacets({ nozzle: ['0.4 mm'], printerModel: ['Bambu Lab H2D'] }), 2)
})
