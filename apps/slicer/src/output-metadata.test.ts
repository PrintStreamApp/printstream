import assert from 'node:assert/strict'
import test from 'node:test'
import { applyManualFilamentMapToModelSettings, buildSlicedArtifactMetadata, rewriteProjectSettingsMetadata, rewriteSliceInfoMetadata } from './output-metadata.js'

test('rewriteSliceInfoMetadata replaces stale printer model and filament metadata', () => {
  const metadata = buildSlicedArtifactMetadata({
    sourceFileId: 'source-file',
    target: {
      mode: 'manualProfile',
      printerModel: 'H2D',
      printerProfileId: 'machine-profile',
      processProfileId: 'process-profile',
      filamentMappings: [
        { projectFilamentId: 1, material: 'Bambu PETG HF', color: '#ffffff', profileId: 'filament-profile-1', source: 'manual' },
        { projectFilamentId: 2, material: 'Bambu PETG HF', color: '#000000', profileId: 'filament-profile-2', source: 'manual' }
      ]
    },
    outputFileName: 'example.gcode.3mf',
    plate: 0
  }, [
    { id: 'machine-profile', kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle' },
    { id: 'process-profile', kind: 'process', name: '0.08mm Extra Fine @BBL H2D' },
    { id: 'filament-profile-1', kind: 'filament', name: 'Bambu PETG HF' },
    { id: 'filament-profile-2', kind: 'filament', name: 'Bambu PETG HF' }
  ])

  assert.ok(metadata)

  const rewritten = rewriteSliceInfoMetadata(`
    <config>
      <plate>
        <metadata key="printer_model_id" value="X1C"/>
        <filament id="1" type="ABS" color="#FFC72C" used_g="12.34" used_m="4.56"/>
        <filament id="2" type="ABS" color="#000000" used_g="1.23" used_m="0.45"/>
      </plate>
    </config>
  `, metadata)

  assert.match(rewritten, /printer_model_id" value="O1D"/)
  assert.match(rewritten, /filament id="1"[^>]*type="PETG-HF"[^>]*color="#FFFFFF"/)
  assert.match(rewritten, /filament id="2"[^>]*type="PETG-HF"[^>]*color="#000000"/)
})

test('rewriteSliceInfoMetadata writes the Bambu model code and inserts it when missing', () => {
  const buildMetadataFor = (printerModel: string) =>
    buildSlicedArtifactMetadata({
      sourceFileId: 'source-file',
      target: {
        mode: 'manualProfile',
        printerModel,
        printerProfileId: 'machine-profile',
        processProfileId: 'process-profile',
        filamentMappings: []
      },
      outputFileName: 'example.gcode.3mf',
      plate: 0
    }, [
      { id: 'machine-profile', kind: 'machine', name: `Bambu Lab ${printerModel} 0.4 nozzle` },
      { id: 'process-profile', kind: 'process', name: '0.20mm Standard' }
    ])

  // P1S maps to the "C12" model_id, inserted into a plate that has no existing id.
  const p1s = buildMetadataFor('P1S')
  assert.ok(p1s)
  const inserted = rewriteSliceInfoMetadata('<config>\n  <plate>\n  </plate>\n</config>', p1s)
  assert.match(inserted, /printer_model_id" value="C12"/)

  // Spaced display form (e.g. from profile-name extraction) resolves too.
  const h2dPro = buildMetadataFor('H2D Pro')
  assert.ok(h2dPro)
  const proRewritten = rewriteSliceInfoMetadata(
    '<config><plate><metadata key="printer_model_id" value="STALE"/></plate></config>',
    h2dPro
  )
  assert.match(proRewritten, /printer_model_id" value="O1E"/)

  // Unknown models leave the slicer's own printer_model_id untouched.
  const unknown = buildMetadataFor('unknown')
  assert.ok(unknown)
  const untouched = rewriteSliceInfoMetadata(
    '<config><plate><metadata key="printer_model_id" value="O1D"/></plate></config>',
    unknown
  )
  assert.match(untouched, /printer_model_id" value="O1D"/)
})

test('rewriteProjectSettingsMetadata replaces stale project printer and filament settings', () => {
  const metadata = buildSlicedArtifactMetadata({
    sourceFileId: 'source-file',
    target: {
      mode: 'manualProfile',
      printerModel: 'H2D',
      printerProfileId: 'machine-profile',
      processProfileId: 'process-profile',
      filamentMappings: [
        { projectFilamentId: 1, material: 'Bambu PETG HF', color: '#ffffff', profileId: 'filament-profile', source: 'manual', toolheadId: 'nozzle-1' }
      ]
    },
    outputFileName: 'example.gcode.3mf',
    plate: 0
  }, [
    { id: 'machine-profile', kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle' },
    { id: 'process-profile', kind: 'process', name: '0.08mm Extra Fine @BBL H2D' },
    { id: 'filament-profile', kind: 'filament', name: 'Bambu PETG HF' }
  ])

  assert.ok(metadata)

  const rewritten = rewriteProjectSettingsMetadata({
    printer_settings_id: ['Bambu Lab X1 Carbon 0.4 nozzle'],
    print_settings_id: ['0.20mm Standard @BBL X1C'],
    filament_type: ['ABS'],
    filament_colour: ['#FFC72C'],
    filament_settings_id: ['Bambu ABS @base']
  }, metadata)

  assert.deepEqual(rewritten.printer_model, 'Bambu Lab H2D')
  assert.deepEqual(rewritten.printer_settings_id, ['Bambu Lab H2D 0.4 nozzle'])
  assert.deepEqual(rewritten.print_settings_id, ['0.08mm Extra Fine @BBL H2D'])
  assert.deepEqual(rewritten.filament_type, ['PETG-HF'])
  assert.deepEqual(rewritten.filament_colour, ['#FFFFFF'])
  assert.deepEqual(rewritten.filament_settings_id, ['Bambu PETG HF'])
  assert.deepEqual(rewritten.filament_nozzle_map, ['1'])
})

test('rewriteProjectSettingsMetadata falls back to cleaned material names when no filament profile id is provided', () => {
  const metadata = buildSlicedArtifactMetadata({
    sourceFileId: 'source-file',
    target: {
      mode: 'manualProfile',
      printerModel: 'H2D',
      printerProfileId: 'machine-profile',
      processProfileId: 'process-profile',
      filamentMappings: [
        { projectFilamentId: 1, material: 'Bambu PETG HF @base', color: '#ffffff', source: 'manual' },
        { projectFilamentId: 2, material: 'Bambu PETG HF @BBL H2D', color: '#000000', source: 'manual' }
      ]
    },
    outputFileName: 'example.gcode.3mf',
    plate: 0
  }, [
    { id: 'machine-profile', kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle' },
    { id: 'process-profile', kind: 'process', name: '0.08mm Extra Fine @BBL H2D' }
  ])

  assert.ok(metadata)

  const rewritten = rewriteProjectSettingsMetadata({
    filament_settings_id: ['Bambu ABS @base', 'Bambu ABS @BBL H2D']
  }, metadata)

  assert.deepEqual(rewritten.filament_settings_id, ['Bambu PETG HF', 'Bambu PETG HF'])
})

test('rewriteProjectSettingsMetadata preserves selected dual-nozzle assignments', () => {
  const metadata = buildSlicedArtifactMetadata({
    sourceFileId: 'source-file',
    target: {
      mode: 'manualProfile',
      printerModel: 'H2D',
      printerProfileId: 'machine-profile',
      processProfileId: 'process-profile',
      filamentMappings: [
        { projectFilamentId: 1, material: 'ABS', color: '#ffff00', source: 'manual', toolheadId: 'nozzle-1' },
        { projectFilamentId: 2, material: 'ABS', color: '#000000', source: 'manual', toolheadId: 'nozzle-0' }
      ]
    },
    outputFileName: 'example.gcode.3mf',
    plate: 0
  }, [
    { id: 'machine-profile', kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle' },
    { id: 'process-profile', kind: 'process', name: '0.08mm Extra Fine @BBL H2D' }
  ])

  assert.ok(metadata)

  const rewritten = rewriteProjectSettingsMetadata({
    filament_nozzle_map: ['0', '1']
  }, metadata)

  assert.deepEqual(rewritten.filament_nozzle_map, ['1', '0'])
})

test('rewriteProjectSettingsMetadata writes runtime nozzle ids verbatim under a non-identity physical_extruder_map (H2D 0300-4010 regression)', () => {
  // A toolheadId carries a runtime nozzle id (0 = right, 1 = left) — the same space
  // the index parser (`extractNozzleMapping`) canonicalises every BambuStudio quirk
  // into, and the same space `filament_nozzle_map` is read back in. The write path
  // must echo that id verbatim. Re-inverting it through `physical_extruder_map`
  // (["1","0"] on the H2D) was the bug: a single-filament plate whose source already
  // carried the correct ["1","0","0"] was rewritten to ["0","1","1"], forcing the
  // filament onto the wrong nozzle and failing dual-nozzle offset calibration
  // (printer error 0300-4010). BambuStudio's own slice of this project emits
  // ["1","0","0"]; we must match it byte-for-byte so the assignment round-trips.
  //
  // Read half (source ["1","0","0"] -> nozzleIds [1,0,0]) is covered by
  // apps/api/src/lib/three-mf.test.ts; here we assert the write half closes the loop.
  const metadata = buildSlicedArtifactMetadata({
    sourceFileId: 'source-file',
    target: {
      mode: 'manualProfile',
      printerModel: 'H2D',
      printerProfileId: 'machine-profile',
      processProfileId: 'process-profile',
      filamentMappings: [
        { projectFilamentId: 1, material: 'ABS', color: '#ffc72c', source: 'manual', toolheadId: 'nozzle-1' },
        { projectFilamentId: 2, material: 'ABS', color: '#789d4a', source: 'manual', toolheadId: 'nozzle-0' },
        { projectFilamentId: 3, material: 'ABS', color: '#ffffff', source: 'manual', toolheadId: 'nozzle-0' }
      ]
    },
    outputFileName: 'example.gcode.3mf',
    plate: 0
  }, [
    { id: 'machine-profile', kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle' },
    { id: 'process-profile', kind: 'process', name: '0.08mm Extra Fine @BBL H2D' }
  ])

  assert.ok(metadata)

  const rewritten = rewriteProjectSettingsMetadata({
    physical_extruder_map: ['1', '0'],
    filament_nozzle_map: ['1', '0', '0'],
    filament_map_mode: 'Auto For Flush',
    filament_map: ['1', '1', '1']
  }, metadata)

  assert.deepEqual(rewritten.filament_nozzle_map, ['1', '0', '0'])
  // `filament_nozzle_map` is metadata; `filament_map` + `filament_map_mode` are what
  // the CLI actually slices against. Left at the project's "Auto For Flush", the
  // slicer reassigns nozzles for flush and ignores the chosen Left/Right (so blue,
  // chosen Left, could slice onto the right nozzle). Pin Manual and write the
  // slicer-extruder inverse of the runtime ids: blue (nozzle 1 = Left) -> extruder 1,
  // white/support (nozzle 0 = Right) -> extruder 2 via physical_extruder_map ["1","0"].
  assert.deepEqual(rewritten.filament_map, ['1', '2', '2'])
  assert.equal(rewritten.filament_map_mode, 'Manual')
})

test('rewriteProjectSettingsMetadata writes runtime nozzle ids verbatim under an identity physical_extruder_map', () => {
  // Identity-map duals must round-trip too: the read path hands us runtime ids and we
  // echo them unchanged, independent of the machine map. Verbatim write is therefore
  // correct for every model.
  const metadata = buildSlicedArtifactMetadata({
    sourceFileId: 'source-file',
    target: {
      mode: 'manualProfile',
      printerModel: 'X2D',
      printerProfileId: 'machine-profile',
      processProfileId: 'process-profile',
      filamentMappings: [
        { projectFilamentId: 1, material: 'ABS', color: '#ffff00', source: 'manual', toolheadId: 'nozzle-1' },
        { projectFilamentId: 2, material: 'ABS', color: '#000000', source: 'manual', toolheadId: 'nozzle-0' }
      ]
    },
    outputFileName: 'example.gcode.3mf',
    plate: 0
  }, [
    { id: 'machine-profile', kind: 'machine', name: 'Bambu Lab X2D 0.4 nozzle' },
    { id: 'process-profile', kind: 'process', name: '0.20mm Standard @BBL X2D' }
  ])

  assert.ok(metadata)

  const rewritten = rewriteProjectSettingsMetadata({
    physical_extruder_map: ['0', '1'],
    filament_nozzle_map: ['1', '0'],
    filament_map_mode: 'Auto For Flush'
  }, metadata)

  assert.deepEqual(rewritten.filament_nozzle_map, ['1', '0'])
  // Identity map inverts the extruder lookup vs the H2D: nozzle 1 (Left) -> extruder 2,
  // nozzle 0 (Right) -> extruder 1. Manual mode still applies on every dual-nozzle map.
  assert.deepEqual(rewritten.filament_map, ['2', '1'])
  assert.equal(rewritten.filament_map_mode, 'Manual')
})

test('rewriteProjectSettingsMetadata leaves filament_nozzle_map untouched for single-nozzle assignments', () => {
  // Single-nozzle printers have no toolhead choice: the dialog sends a non-numeric
  // toolhead ("primary"/none), so nozzleId is null and we must not invent a
  // filament_nozzle_map entry.
  const metadata = buildSlicedArtifactMetadata({
    sourceFileId: 'source-file',
    target: {
      mode: 'manualProfile',
      printerModel: 'P1S',
      printerProfileId: 'machine-profile',
      processProfileId: 'process-profile',
      filamentMappings: [
        { projectFilamentId: 1, material: 'PLA', color: '#ffffff', source: 'manual', toolheadId: 'primary' }
      ]
    },
    outputFileName: 'example.gcode.3mf',
    plate: 0
  }, [
    { id: 'machine-profile', kind: 'machine', name: 'Bambu Lab P1S 0.4 nozzle' },
    { id: 'process-profile', kind: 'process', name: '0.20mm Standard @BBL P1S' }
  ])

  assert.ok(metadata)

  const rewritten = rewriteProjectSettingsMetadata({
    filament_nozzle_map: ['0'],
    filament_map_mode: 'Auto For Flush'
  }, metadata)

  assert.deepEqual(rewritten.filament_nozzle_map, ['0'])
  // No physical_extruder_map (single nozzle): never pin Manual or invent a filament_map.
  assert.equal(rewritten.filament_map, undefined)
  assert.equal(rewritten.filament_map_mode, 'Auto For Flush')
})

test('rewriteProjectSettingsMetadata resolves support materials to their base polymer', () => {
  const metadata = buildSlicedArtifactMetadata({
    sourceFileId: 'source-file',
    target: {
      mode: 'manualProfile',
      printerModel: 'H2D',
      printerProfileId: 'machine-profile',
      processProfileId: 'process-profile',
      filamentMappings: [
        { projectFilamentId: 1, material: 'Bambu Support for ABS', color: '#ffffff', source: 'manual' },
        { projectFilamentId: 2, material: 'Bambu Support for PLA/PETG', color: '#000000', source: 'manual' },
        { projectFilamentId: 3, material: 'Bambu Support For PA/PET', color: '#c0df16', source: 'manual' },
        { projectFilamentId: 4, material: 'Bambu Support W', color: '#ffffff', source: 'manual' }
      ]
    },
    outputFileName: 'example.gcode.3mf',
    plate: 0
  }, [
    { id: 'machine-profile', kind: 'machine', name: 'Bambu Lab H2D 0.4 nozzle' },
    { id: 'process-profile', kind: 'process', name: '0.08mm Extra Fine @BBL H2D' }
  ])

  assert.ok(metadata)

  const rewritten = rewriteProjectSettingsMetadata({
    filament_type: ['ABS', 'ABS', 'ABS', 'ABS']
  }, metadata)

  // Never emit "SUPPORT"/"SUPPORT-FOR" as a filament_type; that produced a false
  // material mismatch against AMS tray codes like "ABS-S".
  assert.deepEqual(rewritten.filament_type, ['ABS', 'PLA', 'PA', 'PLA'])
})

test('rewriteProjectSettingsMetadata emits printer_model as Bambu\'s per-model name (string) derived from the machine preset', () => {
  // Match what BambuStudio writes for each model exactly, derived from the loaded
  // machine preset name (preset minus the nozzle-size suffix), so we never stray with
  // an internal short code or a stale per-model table. Covers multi-word names, the
  // "mini" variant, and a non-0.4 nozzle size.
  const cases = [
    { profile: 'Bambu Lab H2D 0.4 nozzle', model: 'H2D', expected: 'Bambu Lab H2D' },
    { profile: 'Bambu Lab X1 Carbon 0.4 nozzle', model: 'X1C', expected: 'Bambu Lab X1 Carbon' },
    { profile: 'Bambu Lab A1 mini 0.4 nozzle', model: 'A1mini', expected: 'Bambu Lab A1 mini' },
    { profile: 'Bambu Lab P1S 0.6 nozzle', model: 'P1S', expected: 'Bambu Lab P1S' }
  ]
  for (const { profile, model, expected } of cases) {
    const metadata = buildSlicedArtifactMetadata({
      sourceFileId: 'source-file',
      target: {
        mode: 'manualProfile',
        printerModel: model,
        printerProfileId: 'machine-profile',
        processProfileId: 'process-profile',
        filamentMappings: []
      },
      outputFileName: 'example.gcode.3mf',
      plate: 0
    }, [
      { id: 'machine-profile', kind: 'machine', name: profile },
      { id: 'process-profile', kind: 'process', name: '0.20mm Standard' }
    ])

    assert.ok(metadata)

    const rewritten = rewriteProjectSettingsMetadata({ printer_model: 'Bambu Lab X1 Carbon' }, metadata)

    assert.equal(rewritten.printer_model, expected, `${profile} -> ${expected}`)
  }
})

test('applyManualFilamentMapToModelSettings forces Manual mode + pins filament_maps on every plate (CLI source of truth)', () => {
  // model_settings.config — not project_settings.config — is what the slicer CLI reads
  // for filament_map_mode, so a manual nozzle choice must be forced here or the slice
  // stays "Auto For Flush" and the chosen nozzle is discarded.
  const xml = [
    '<config>',
    '  <plate>',
    '    <metadata key="plater_id" value="1"/>',
    '    <metadata key="filament_map_mode" value="Auto For Flush"/>',
    '  </plate>',
    '  <plate>',
    '    <metadata key="plater_id" value="2"/>',
    '    <metadata key="filament_map_mode" value="Auto For Flush"/>',
    '  </plate>',
    '</config>'
  ].join('\n')
  const out = applyManualFilamentMapToModelSettings(xml, '1 2 2')
  assert.equal(/Auto For Flush/.test(out), false)
  assert.equal((out.match(/filament_map_mode" value="Manual"/g) || []).length, 2)
  assert.equal((out.match(/filament_maps" value="1 2 2"/g) || []).length, 2)
})

test('applyManualFilamentMapToModelSettings replaces an existing filament_maps instead of duplicating it', () => {
  const xml = '<plate><metadata key="filament_map_mode" value="Manual"/><metadata key="filament_maps" value="2 1"/></plate>'
  const out = applyManualFilamentMapToModelSettings(xml, '1 2')
  assert.equal((out.match(/filament_maps" value=/g) || []).length, 1)
  assert.match(out, /filament_maps" value="1 2"/)
})

test('applyManualFilamentMapToModelSettings inserts the assignment when the source plate has no filament_map_mode (the real case)', () => {
  // Source 3MFs carry no filament_map_mode at all — the CLI defaults to "Auto For Flush"
  // at slice time — so the transform must ADD it per plate, not only replace an existing one.
  const xml = '<config>\n  <plate>\n    <metadata key="plater_id" value="1"/>\n    <metadata key="plater_name" value=""/>\n  </plate>\n</config>'
  const out = applyManualFilamentMapToModelSettings(xml, '1 2 2')
  assert.match(out, /filament_map_mode" value="Manual"/)
  assert.match(out, /filament_maps" value="1 2 2"/)
  assert.match(out, /plater_id" value="1"/)
})
