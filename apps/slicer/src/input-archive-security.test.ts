import assert from 'node:assert/strict'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import yazl from 'yazl'
import { assertNoSlicerHostScripts, validateSlicerInputArchive } from './input-archive-security.js'

async function writeZip(filePath: string, entries: Array<[string, string]>): Promise<void> {
  const zip = new yazl.ZipFile()
  const output = createWriteStream(filePath)
  zip.outputStream.pipe(output)
  for (const [name, content] of entries) zip.addBuffer(Buffer.from(content), name)
  zip.end()
  await new Promise<void>((resolve, reject) => {
    output.on('close', resolve)
    output.on('error', reject)
  })
}

test('the slicer boundary rejects duplicate names and host scripts independently of the API', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'slicer-input-security-'))
  try {
    const duplicate = path.join(dir, 'duplicate.3mf')
    await writeZip(duplicate, [['Metadata/a.txt', 'one'], ['metadata/a.txt', 'two']])
    await assert.rejects(
      validateSlicerInputArchive(duplicate, { maxEntries: 10, maxInflatedBytes: 1024 }),
      /duplicate entry names/
    )

    const scripts = path.join(dir, 'scripts.3mf')
    await writeZip(scripts, [['Metadata/project_settings.config', '{"post_process":["host-command"]}']])
    await validateSlicerInputArchive(scripts, { maxEntries: 10, maxInflatedBytes: 1024 })
    await assert.rejects(assertNoSlicerHostScripts(scripts), /Post-processing scripts cannot run/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
