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
