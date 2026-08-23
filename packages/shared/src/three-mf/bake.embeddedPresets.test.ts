/**
 * The removal has to reach the ARCHIVE, not just the UI: BambuStudio re-embeds every sidecar it
 * finds on every save, so a preset it fabricated once reappears in the user's filament dropdown
 * forever unless the entry itself stops being written.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { emptyThreeMfBakeSource, planEditedThreeMf } from './bake.js'
import type { SceneEdit } from '../slicing.js'

/** A minimal base source: enough for the plan to take the `copy` branch. */
function baseSource() {
  return { ...emptyThreeMfBakeSource(), hasBase: true }
}

const edit = (removed?: string[]): SceneEdit => ({
  plates: [],
  instances: [],
  ...(removed ? { removedEmbeddedPresets: removed } : {})
} as unknown as SceneEdit)

test('a removed embedded preset is dropped from the output archive', () => {
  const plan = planEditedThreeMf(baseSource(), edit(['Metadata/filament_settings_1.config']))
  const transform = plan.copy?.transforms.get('Metadata/filament_settings_1.config')

  assert.ok(transform, 'the entry must be transformed rather than copied through')
  // Null from a transform is how this plan expresses "drop the entry".
  assert.equal(transform('{"name":"junk(project.3mf)"}'), null)
})

test('an untouched project drops nothing', () => {
  const plan = planEditedThreeMf(baseSource(), edit())
  assert.equal(plan.copy?.transforms.has('Metadata/filament_settings_1.config'), false)
})

/**
 * The removal list is entry paths, and it must not become a way to delete arbitrary archive
 * entries: a caller (or a replayed request) naming `3D/3dmodel.model` would otherwise destroy the
 * project's geometry.
 */
test('only embedded-preset entries can be removed this way', () => {
  const plan = planEditedThreeMf(baseSource(), edit([
    '3D/3dmodel.model',
    'Metadata/project_settings.config',
    'Metadata/filament_settings_2.config'
  ]))

  // Both of these carry their OWN transforms (the bake rewrites them), so the property to check is
  // that neither returns null: i.e. neither is dropped from the archive.
  assert.notEqual(plan.copy?.transforms.get('3D/3dmodel.model')?.('<model/>'), null, 'geometry must survive')
  const projectSettings = plan.copy?.transforms.get('Metadata/project_settings.config')
  if (projectSettings) assert.notEqual(projectSettings('{}'), null, 'the project config must survive')
  // ...while the one entry this list is FOR is dropped.
  assert.equal(plan.copy?.transforms.get('Metadata/filament_settings_2.config')?.(''), null)
})
