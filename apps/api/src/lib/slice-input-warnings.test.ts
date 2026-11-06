/**
 * The slice-time prediction's archive I/O and its best-effort contract. The rule itself is pinned
 * in `@printstream/shared` (`by-object-linked-copies.test.ts`).
 */
import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import yazl from 'yazl'
import { predictSliceInputWarnings } from './slice-input-warnings.js'

const ENGINE = { family: 'bambustudio', version: '2.8.2.61' }
const dir = await mkdtemp(path.join(tmpdir(), 'slice-input-warnings-'))
after(() => rm(dir, { recursive: true, force: true }))

async function writeZip(name: string, entries: Array<[string, string]>): Promise<string> {
  const filePath = path.join(dir, name)
  const zip = new yazl.ZipFile()
  for (const [entryPath, content] of entries) zip.addBuffer(Buffer.from(content, 'utf8'), entryPath)
  await new Promise<void>((resolve, reject) => {
    zip.outputStream.pipe(createWriteStream(filePath)).on('close', resolve).on('error', reject)
    zip.end()
  })
  return filePath
}

/** One object ("Gutter", id 5) placed twice on plate 1 under the given project sequence. */
function linkedPairProject(projectSequence: string): Array<[string, string]> {
  const item = (x: number) => `<item objectid="5" transform="1 0 0 0 1 0 0 0 1 ${x} 128 4" printable="1"/>`
  const instance = (instanceId: number) =>
    `<model_instance><metadata key="object_id" value="5"/><metadata key="instance_id" value="${instanceId}"/></model_instance>`
  return [
    ['3D/3dmodel.model', `<model><resources/><build>${item(70)}${item(190)}</build></model>`],
    ['Metadata/model_settings.config', `<config><object id="5"><metadata key="name" value="Gutter"/></object><plate><metadata key="plater_id" value="1"/>${instance(0)}${instance(1)}</plate></config>`],
    ['Metadata/project_settings.config', JSON.stringify({ print_sequence: projectSequence })]
  ]
}

test('a by-object linked pair on an affected engine is predicted', async () => {
  const sourcePath = await writeZip('by-object.3mf', linkedPairProject('by object'))

  const warnings = await predictSliceInputWarnings({ sourcePath, plate: 1, engine: ENGINE })

  assert.equal(warnings.length, 1)
  assert.match(warnings[0]!, /^Gutter: its 2 linked copies will print together/)
  // Plate 0 (slice every plate) checks the same plate.
  assert.equal((await predictSliceInputWarnings({ sourcePath, plate: 0, engine: ENGINE })).length, 1)
})

test('by layer, another engine, or an unreadable project predicts nothing', async () => {
  const byLayer = await writeZip('by-layer.3mf', linkedPairProject('by layer'))
  assert.deepEqual(await predictSliceInputWarnings({ sourcePath: byLayer, plate: 1, engine: ENGINE }), [])

  const byObject = await writeZip('by-object-other.3mf', linkedPairProject('by object'))
  assert.deepEqual(await predictSliceInputWarnings({ sourcePath: byObject, plate: 1, engine: { family: 'orcaslicer', version: '2.4.2' } }), [])
  assert.deepEqual(await predictSliceInputWarnings({ sourcePath: byObject, plate: 1, engine: null }), [])

  // A plain mesh project has no model settings, and a missing file must not throw either.
  const meshOnly = await writeZip('mesh-only.3mf', [['3D/3dmodel.model', '<model><resources/><build/></model>']])
  assert.deepEqual(await predictSliceInputWarnings({ sourcePath: meshOnly, plate: 1, engine: ENGINE }), [])
  assert.deepEqual(await predictSliceInputWarnings({ sourcePath: path.join(dir, 'missing.3mf'), plate: 1, engine: ENGINE }), [])
})
