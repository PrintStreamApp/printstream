import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isSolubleFilament,
  isSupportMaterialFilament,
  recommendSupportSettingsForInterfaceFilament,
  type ProcessConfig,
  type SupportRecommendationFilament
} from './index.js'

/** A process config far enough from every recommendation that all four/five keys move. */
function defaultConfig(overrides: ProcessConfig = {}): ProcessConfig {
  return {
    support_top_z_distance: '0.2',
    support_interface_spacing: '0.5',
    support_object_xy_distance: '0.35',
    support_interface_pattern: 'auto',
    independent_support_layer_height: '1',
    ...overrides
  }
}

function filament(
  id: number,
  filamentType: string,
  extra: Partial<SupportRecommendationFilament> = {}
): SupportRecommendationFilament {
  return { id, filamentType, filamentName: null, ...extra }
}

test('recommends the TPU set when PLA interfaces a plate that prints TPU', () => {
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 1,
    supportFilamentId: 0,
    filaments: [filament(1, 'PLA'), filament(2, 'TPU')],
    config: defaultConfig()
  })
  assert.equal(result?.case, 'supportTpu')
  assert.deepEqual(result?.changes, {
    support_top_z_distance: '0',
    support_interface_spacing: '0',
    support_object_xy_distance: '0',
    support_interface_pattern: 'rectilinear_interlaced',
    independent_support_layer_height: '0'
  })
})

test('recommends the soluble set when a soluble interface sits over a non-soluble base', () => {
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 2,
    supportFilamentId: 1,
    filaments: [filament(1, 'PLA'), filament(2, 'PVA')],
    config: defaultConfig()
  })
  assert.equal(result?.case, 'solubleInterface')
  assert.equal(result?.changes.support_object_xy_distance, '0')
})

test('does not propose the soluble set when the support base is soluble too', () => {
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 2,
    supportFilamentId: 1,
    filaments: [filament(1, 'BVOH'), filament(2, 'PVA')],
    config: defaultConfig()
  })
  assert.equal(result, null)
})

test('recommends the support-material set WITHOUT touching support_object_xy_distance', () => {
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 2,
    supportFilamentId: 1,
    filaments: [filament(1, 'PLA'), filament(2, 'PLA-S', { filamentName: 'Bambu Support For PLA/PETG' })],
    config: defaultConfig()
  })
  assert.equal(result?.case, 'supportMaterial')
  assert.deepEqual(result?.changes, {
    support_top_z_distance: '0',
    support_interface_spacing: '0',
    support_interface_pattern: 'rectilinear_interlaced',
    independent_support_layer_height: '0'
  })
  assert.ok(!('support_object_xy_distance' in (result?.changes ?? {})))
})

test('returns null when the config already matches the recommendation', () => {
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 2,
    supportFilamentId: 1,
    filaments: [filament(1, 'PLA'), filament(2, 'PLA-S')],
    config: defaultConfig({
      support_top_z_distance: '0',
      support_interface_spacing: '0',
      support_interface_pattern: 'rectilinear_interlaced',
      independent_support_layer_height: '0'
    })
  })
  assert.equal(result, null)
})

test('proposes only the keys that would actually change', () => {
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 2,
    supportFilamentId: 1,
    filaments: [filament(1, 'PLA'), filament(2, 'PLA-S')],
    config: defaultConfig({ support_top_z_distance: '0.00', support_interface_spacing: '0' })
  })
  assert.deepEqual(result?.changes, {
    support_interface_pattern: 'rectilinear_interlaced',
    independent_support_layer_height: '0'
  })
})

test('returns null for the "Default" interface selection and for unknown slots', () => {
  const filaments = [filament(1, 'PLA'), filament(2, 'PVA')]
  assert.equal(
    recommendSupportSettingsForInterfaceFilament({ interfaceFilamentId: 0, supportFilamentId: 0, filaments, config: defaultConfig() }),
    null
  )
  assert.equal(
    recommendSupportSettingsForInterfaceFilament({ interfaceFilamentId: 9, supportFilamentId: 0, filaments, config: defaultConfig() }),
    null
  )
})

test('an ordinary interface material on an ordinary plate proposes nothing', () => {
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 2,
    supportFilamentId: 1,
    filaments: [filament(1, 'PLA'), filament(2, 'PETG')],
    config: defaultConfig()
  })
  assert.equal(result, null)
})

test('the project flags override the name/type heuristics in both directions', () => {
  // A "Support"-named filament the project explicitly flags as NOT support stays ordinary.
  assert.equal(
    isSupportMaterialFilament(filament(1, 'PLA', { filamentName: 'Support Blue', isSupport: false })),
    false
  )
  assert.equal(isSupportMaterialFilament(filament(1, 'PETG', { isSupport: true })), true)
  // PVA flagged non-soluble (an odd project, but the flag is authoritative) is not soluble.
  assert.equal(isSolubleFilament(filament(1, 'PVA', { isSoluble: false })), false)
  assert.equal(isSolubleFilament(filament(1, 'PETG', { isSoluble: true })), true)
  // Falling back to naming when the project carried no flags.
  assert.equal(isSupportMaterialFilament(filament(1, 'PLA-S')), true)
  assert.equal(isSolubleFilament(filament(1, 'BVOH')), true)
  assert.equal(isSolubleFilament(filament(1, 'PLA')), false)
})

test('TPU takes precedence over the support-material case for a PLA-S interface on a TPU plate', () => {
  // Mirrors BambuStudio's branch order: support_TPU is tested first. A PLA interface is the
  // only one that can hit it, so a PLA-S interface still falls through to the support case.
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 2,
    supportFilamentId: 1,
    filaments: [filament(1, 'TPU'), filament(2, 'PLA-S')],
    config: defaultConfig()
  })
  assert.equal(result?.case, 'supportMaterial')
})

// --- Combination-table lookups (BambuStudio's support_recommended_params.json) ---

/** The full tree-hybrid conversion the table recommends for PLA<->PETG pairings. */
const TREE_HYBRID_FULL_EXPECTED = {
  enable_support: '1',
  support_type: 'tree(auto)',
  support_style: 'tree_hybrid',
  support_threshold_angle: '35',
  support_on_build_plate_only: '0',
  raft_first_layer_expansion: '5',
  support_top_z_distance: '0',
  support_interface_pattern: 'rectilinear_interlaced',
  support_interface_spacing: '0',
  tree_support_branch_diameter: '3',
  tree_support_branch_diameter_angle: '7',
  support_interface_speed: '50'
}

test('a PLA interface on a homogeneous PETG plate proposes the combination set (issue #79)', () => {
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 2,
    supportFilamentId: 0,
    // Model material is Bambu PETG HF: the "HF" lives only in the preset NAME; filament_type
    // is plain PETG, which is what the table matches on.
    filaments: [filament(1, 'PETG', { filamentName: 'Bambu PETG HF @BBL X1C' }), filament(2, 'PLA')],
    modelFilamentIds: [1],
    config: defaultConfig()
  })
  assert.equal(result?.case, 'combination')
  assert.equal(result?.reason, 'PLA is being used to support PETG.')
  assert.deepEqual(result?.changes, TREE_HYBRID_FULL_EXPECTED)
})

test('the combination table outranks the soluble-interface fallback', () => {
  // PVA over a PLA model matches BOTH the table (PLA <- PVA) and the soluble fallback.
  // Studio consults the table first; its set enables support and switches to tree(auto),
  // which the fallback set never does — and it omits independent_support_layer_height.
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 2,
    supportFilamentId: 0,
    filaments: [filament(1, 'PLA'), filament(2, 'PVA')],
    modelFilamentIds: [1],
    config: defaultConfig()
  })
  assert.equal(result?.case, 'combination')
  assert.deepEqual(result?.changes, {
    enable_support: '1',
    support_type: 'tree(auto)',
    support_on_build_plate_only: '0',
    support_top_z_distance: '0',
    support_interface_pattern: 'rectilinear_interlaced',
    support_interface_spacing: '0',
    support_object_xy_distance: '0'
  })
})

test('a table hit whose values are already configured suppresses the fallback prompt too', () => {
  // Mirrors Tab.cpp: once the JSON query matches, the hard-coded cases are never consulted —
  // even when every table value is already in place and the fallback WOULD still move keys
  // (independent_support_layer_height is only in the fallback set).
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 2,
    supportFilamentId: 0,
    filaments: [filament(1, 'PLA'), filament(2, 'PVA')],
    modelFilamentIds: [1],
    config: defaultConfig({
      enable_support: '1',
      support_type: 'tree(auto)',
      support_on_build_plate_only: '0',
      support_top_z_distance: '0',
      support_interface_pattern: 'rectilinear_interlaced',
      support_interface_spacing: '0',
      support_object_xy_distance: '0'
    })
  })
  assert.equal(result, null)
})

test('a name-matched support material wins over its -S type classification', () => {
  // "Bambu Support For PLA/PETG" on a PETG model is a NAME entry in the table; without the
  // table this fell through to the generic supportMaterial fallback (the -S type suffix).
  // The label arrives vendor-stripped here, as the picker-grouped display names are.
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 2,
    supportFilamentId: 0,
    filaments: [
      filament(1, 'PETG', { filamentName: 'Bambu PETG HF' }),
      filament(2, 'PLA-S', { filamentName: 'Support For PLA/PETG' })
    ],
    modelFilamentIds: [1],
    config: defaultConfig()
  })
  assert.equal(result?.case, 'combination')
  assert.deepEqual(result?.changes, TREE_HYBRID_FULL_EXPECTED)
})

test('name matching strips the @printer suffix, and homogeneity can hold by NAME', () => {
  // Two PA6-GF slots (different colours) share one preset name, so the model side is
  // homogeneous by name even though a second type would break type-homogeneity; the
  // "Bambu PA6-GF" <- ABS(type) entry recommends only the interface-contact keys.
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 3,
    supportFilamentId: 0,
    filaments: [
      filament(1, 'PA6-GF', { filamentName: 'Bambu PA6-GF @BBL X1E' }),
      filament(2, 'PA6-GF', { filamentName: 'Bambu PA6-GF @BBL X1E' }),
      filament(3, 'ABS', { filamentName: 'Bambu ABS @BBL X1E' })
    ],
    modelFilamentIds: [1, 2],
    config: defaultConfig()
  })
  assert.equal(result?.case, 'combination')
  assert.deepEqual(result?.changes, {
    support_top_z_distance: '0',
    support_interface_pattern: 'rectilinear_interlaced',
    support_interface_spacing: '0'
  })
})

test('an ASA interface on a PA model matches the named Bambu entry', () => {
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 2,
    supportFilamentId: 0,
    filaments: [filament(1, 'PA'), filament(2, 'ASA', { filamentName: 'Bambu ASA @BBL H2D' })],
    modelFilamentIds: [1],
    config: defaultConfig()
  })
  assert.equal(result?.case, 'combination')
  assert.equal(result?.changes.support_style, 'tree_hybrid')
  assert.equal(result?.changes.enable_support, '1')
})

test('mixed model materials never consult the table', () => {
  // Studio only queries when the plate's model materials share one type or one name.
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 3,
    supportFilamentId: 0,
    filaments: [filament(1, 'PETG'), filament(2, 'ABS'), filament(3, 'PLA')],
    modelFilamentIds: [1, 2],
    config: defaultConfig()
  })
  assert.equal(result, null)
})

test('without modelFilamentIds only the hard-coded fallback cases run', () => {
  // A host that cannot tell which materials the plate's models print with (no plate context)
  // must keep today's behaviour: PLA over PETG proposes nothing.
  const result = recommendSupportSettingsForInterfaceFilament({
    interfaceFilamentId: 2,
    supportFilamentId: 0,
    filaments: [filament(1, 'PETG'), filament(2, 'PLA')],
    config: defaultConfig()
  })
  assert.equal(result, null)
})
