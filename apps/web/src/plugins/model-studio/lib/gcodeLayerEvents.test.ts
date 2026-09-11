import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildGcodeLayerEventMarkers, maxGcodeLayerHeightReference } from './gcodeLayerEvents'

test('maps baked events to the nearest real G-code layers, including adaptive heights', () => {
  const markers = buildGcodeLayerEventMarkers(
    [0.2, 0.4, 0.65, 0.9],
    {
      pauses: [{ z: 0.66 }],
      filamentChanges: [{ z: 0.39, filamentId: 2 }],
      projectFilaments: [{ id: 2, color: '#12ab34' }]
    }
  )

  assert.deepEqual(markers, [
    {
      layer: 1,
      z: 0.4,
      pauseCount: 0,
      filamentChanges: [{ filamentId: 2, color: '#12ab34' }]
    },
    {
      layer: 2,
      z: 0.65,
      pauseCount: 1,
      filamentChanges: []
    }
  ])
})

test('combines coincident event types into one slider position and keeps unknown colours visible', () => {
  const markers = buildGcodeLayerEventMarkers(
    [0.2, 0.4, 0.6],
    {
      pauses: [{ z: 0.4 }, { z: 0.4 }],
      filamentChanges: [{ z: 0.4, filamentId: 7 }]
    }
  )

  assert.deepEqual(markers, [{
    layer: 1,
    z: 0.4,
    pauseCount: 2,
    filamentChanges: [{ filamentId: 7, color: null }]
  }])
})

test('returns no markers when no preview layers were parsed', () => {
  assert.deepEqual(buildGcodeLayerEventMarkers([], {
    pauses: [{ z: 2 }],
    filamentChanges: [{ z: 3, filamentId: 1 }]
  }), [])
})

test('does not assume layer heights stay monotonic for sequential printing', () => {
  const markers = buildGcodeLayerEventMarkers(
    [0.2, 0.4, 0.6, 0.2, 0.4],
    {
      pauses: [{ z: 0.2 }],
      filamentChanges: [{ z: 0.4, filamentId: 3 }]
    },
    {
      pauseLayers: [3],
      filamentChangeLayers: [4]
    }
  )

  assert.deepEqual(markers.map((marker) => marker.layer), [3, 4])
  assert.equal(markers[0]?.pauseCount, 1)
  assert.equal(markers[1]?.filamentChanges[0]?.filamentId, 3)
})

test('falls back to nearest-height placement when reserved G-code tags are unavailable', () => {
  const markers = buildGcodeLayerEventMarkers(
    [0.2, 0.4, 0.6],
    { pauses: [{ z: 0.58 }] }
  )

  assert.equal(markers[0]?.layer, 2)
})

test('reserved G-code tags create markers even when the 3MF sidecar has no events', () => {
  const markers = buildGcodeLayerEventMarkers(
    [0.2, 0.4, 0.6],
    {},
    { pauseLayers: [1], filamentChangeLayers: [2] }
  )

  assert.deepEqual(markers, [
    { layer: 1, z: 0.4, pauseCount: 1, filamentChanges: [] },
    { layer: 2, z: 0.6, pauseCount: 0, filamentChanges: [{ filamentId: null, color: null }] }
  ])
})

test('keeps extra G-code occurrences when the sidecar contains fewer events', () => {
  const markers = buildGcodeLayerEventMarkers(
    [0.2, 0.4, 0.6, 0.8],
    {
      pauses: [{ z: 0.4 }],
      filamentChanges: [{ z: 0.6, filamentId: 2 }],
      projectFilaments: [{ id: 2, color: '#12ab34' }]
    },
    { pauseLayers: [1, 3], filamentChangeLayers: [2, 3] }
  )

  assert.deepEqual(markers, [
    { layer: 1, z: 0.4, pauseCount: 1, filamentChanges: [] },
    { layer: 2, z: 0.6, pauseCount: 0, filamentChanges: [{ filamentId: 2, color: '#12ab34' }] },
    { layer: 3, z: 0.8, pauseCount: 1, filamentChanges: [{ filamentId: null, color: null }] }
  ])
})

test('reserves the greatest formatted Z even when sequential printing later restarts lower', () => {
  assert.equal(maxGcodeLayerHeightReference([0.2, 43.25, 0.2, 12.4]), '43.25 mm')
  assert.equal(maxGcodeLayerHeightReference([]), null)
})
