import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

// The generator ships as a standalone ESM script that runs inside the slicer
// image, so it is imported here by relative path rather than through the
// package entrypoint. It is plain JS with no declaration file.
// @ts-expect-error - untyped sibling ESM script
import { generateFullProfiles } from '../docker/generate-bambustudio-full-profiles.mjs'

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(value, null, 2))
}

test('within-vendor inherits resolution keeps shared template names from colliding', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'full-profiles-'))
  try {
    const profilesRoot = path.join(root, 'profiles')

    // BBL ships the canonical chain that carries layer_height.
    const bblProcess = path.join(profilesRoot, 'BBL', 'process')
    await writeJson(path.join(bblProcess, 'fdm_process_common.json'), {
      name: 'fdm_process_common',
      from: 'system',
      instantiation: 'false',
      layer_height: '0.2',
      resolution: '0.012'
    })
    await writeJson(path.join(bblProcess, 'fdm_process_dual_common.json'), {
      name: 'fdm_process_dual_common',
      from: 'system',
      instantiation: 'false',
      inherits: 'fdm_process_common',
      sparse_infill_density: '15%'
    })
    await writeJson(path.join(bblProcess, 'standard.json'), {
      name: '0.20mm Standard @BBL H2D',
      from: 'system',
      instantiation: 'true',
      inherits: 'fdm_process_dual_common',
      include: ['process_start_gcode'],
      compatible_printers: ['Bambu Lab H2D 0.4 nozzle']
    })

    // A second vendor ships a different fdm_process_common with no layer_height.
    // The pre-fix flat name map let this overwrite BBL's template and drop
    // layer_height from the resolved BBL preset.
    const voxelabProcess = path.join(profilesRoot, 'Voxelab', 'process')
    await writeJson(path.join(voxelabProcess, 'fdm_process_common.json'), {
      name: 'fdm_process_common',
      from: 'system',
      instantiation: 'false',
      top_shell_layers: '4'
    })

    await generateFullProfiles(profilesRoot)

    const bakedRaw = await readFile(
      path.join(profilesRoot, 'process_full', '0.20mm Standard @BBL H2D.json'),
      'utf8'
    )
    const baked = JSON.parse(bakedRaw) as Record<string, unknown>

    // Inherited value keys are baked in from BBL's own chain.
    assert.equal(baked.layer_height, '0.2')
    assert.equal(baked.resolution, '0.012')
    assert.equal(baked.sparse_infill_density, '15%')
    assert.deepEqual(baked.compatible_printers, ['Bambu Lab H2D 0.4 nozzle'])

    // The leaf's own structural directives survive so the CLI still resolves
    // the chain (and its included gcode fragments) against the intact bundle.
    assert.equal(baked.inherits, 'fdm_process_dual_common')
    assert.deepEqual(baked.include, ['process_start_gcode'])

    // The base's internal-only key must not leak from the other vendor.
    assert.equal('top_shell_layers' in baked, false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
