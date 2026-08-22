import assert from 'node:assert/strict'
import test from 'node:test'
import { zipSync, strToU8 } from 'fflate'
import { MAX_CLIENT_THREE_MF_BYTES, ThreeMfArchiveError, openThreeMfArchive } from './threeMfArchive'

/**
 * The archive reader's ERROR contract — what `openThreeMfArchive` refuses, and with what.
 *
 * Its three rejections are the only thing standing between a user's stray file and a viewer that
 * either shows nothing or kills the tab, and they are a real API: `LocalProjectEditor.tsx` catches
 * `ThreeMfArchiveError` and renders `caught.message` verbatim to the user. So the error TYPE and the
 * message text are both load-bearing — swapping either for a bare `Error` or a codec's internal
 * wording is invisible to typecheck and to every other test in this directory.
 *
 * The valid-file cases are the control: a reader that rejected everything would satisfy the failure
 * assertions alone. The size cap is exercised with a stubbed `Blob.size` rather than 256MB of real
 * bytes — the guard reads `size` and nothing else, so allocating the payload would prove nothing
 * extra and cost a quarter-gigabyte per run.
 */

const MODEL_XML = '<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter"><resources></resources><build></build></model>'

/** A Blob over a synthetic 3MF, since `openThreeMfArchive` takes what a file picker hands it. */
function threeMfBlob(entries: Record<string, string>): Blob {
  const zipped = zipSync(Object.fromEntries(
    Object.entries(entries).map(([name, content]) => [name, strToU8(content)])
  ))
  return new Blob([new Uint8Array(zipped)])
}

function validThreeMfBlob(): Blob {
  return threeMfBlob({
    '3D/3dmodel.model': MODEL_XML,
    'Metadata/model_settings.config': '<config></config>'
  })
}

/**
 * Report the size the cap sees without holding the bytes. `size` is a prototype getter, so an own
 * property shadows it while the Blob stays a real Blob for everything downstream.
 */
function blobReportingSize(blob: Blob, size: number): Blob {
  Object.defineProperty(blob, 'size', { value: size, configurable: true })
  return blob
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (caught) {
    return caught
  }
  return assert.fail('openThreeMfArchive resolved where it must reject')
}

/**
 * Every one of these messages is shown to the user unedited, so they must read as an explanation,
 * not as a leaked internal. The jargon list is the vocabulary of the layers underneath — fflate and
 * the zip worker — which the reader exists to translate away.
 */
function assertUserPresentable(caught: unknown): asserts caught is ThreeMfArchiveError {
  assert.ok(
    caught instanceof ThreeMfArchiveError,
    `callers catch ThreeMfArchiveError by type; got ${caught?.constructor?.name ?? typeof caught}`
  )
  const message = caught.message
  assert.match(message, /^[A-Z].*\.$/s, `not a sentence a user can read: ${JSON.stringify(message)}`)
  for (const jargon of ['fflate', 'unzip', 'Worker', 'invalid zip data', 'undefined', 'TypeError']) {
    assert.ok(!message.includes(jargon), `message leaks "${jargon}": ${message}`)
  }
}

test('a valid 3MF opens and exposes its entries', async () => {
  const archive = await openThreeMfArchive(validThreeMfBlob())

  assert.deepEqual(archive.entryNames().sort(), ['3D/3dmodel.model', 'Metadata/model_settings.config'])
  assert.match(archive.entryText('3D/3dmodel.model') ?? '', /<model/)
  assert.equal(archive.entryText('Metadata/nothing_here.config'), null, 'an absent entry is null, not a throw')
  assert.ok(archive.sceneEntries(), 'a project with model settings has a scene')
})

test('a geometry-only 3MF opens; having no scene metadata is not an archive error', async () => {
  // A vanilla CAD export carries no `model_settings.config`. That is the mesh-preview case the
  // library already handles, so the reader must hand it back rather than reject it — only the root
  // model entry is mandatory.
  const archive = await openThreeMfArchive(threeMfBlob({ '3D/3dmodel.model': MODEL_XML }))

  assert.equal(archive.sceneEntries(), null)
  assert.match(archive.entryText('3D/3dmodel.model') ?? '', /<model/)
})

test('a file over the size cap is refused before its bytes are ever read', async () => {
  const blob = blobReportingSize(validThreeMfBlob(), 300 * 1024 * 1024)
  // Reading first is the failure this cap exists to prevent: the decompressed archive is held whole
  // in memory and a tab that exhausts its heap dies with no recoverable error.
  Object.defineProperty(blob, 'arrayBuffer', {
    value: () => assert.fail('the size cap must short-circuit before the archive is read into memory')
  })

  const caught = await rejectionOf(openThreeMfArchive(blob))
  assertUserPresentable(caught)
  assert.match(caught.message, /300 MB/, 'tells the user how big their file is')
  assert.match(caught.message, /256 MB/, 'and what the limit is, so the message is actionable')
})

test('a file exactly at the cap still opens', async () => {
  // The guard is `>`, not `>=`. Pinned because the boundary is unreachable in manual testing and a
  // one-character drift turns the documented limit into "just under the limit".
  const archive = await openThreeMfArchive(blobReportingSize(validThreeMfBlob(), MAX_CLIENT_THREE_MF_BYTES))
  assert.ok(archive.sceneEntries())
})

test('a ZIP with no 3D/3dmodel.model is refused', async () => {
  // Unzips perfectly — an ordinary archive, or a 3MF-adjacent bundle. Without this check the editor
  // opens onto an empty scene, which reads as a broken viewer rather than as the wrong file.
  const caught = await rejectionOf(openThreeMfArchive(threeMfBlob({
    'Metadata/model_settings.config': '<config></config>',
    'readme.txt': 'not a 3MF'
  })))

  assertUserPresentable(caught)
  assert.match(caught.message, /3D\/3dmodel\.model/, 'names the entry that is missing')
})

test('input that is not a ZIP is refused with our wording, not the codec\'s', async () => {
  // The inflate failure arrives as whatever fflate threw ("invalid zip data", a RangeError, …).
  // Surfacing that raw is what the translation in `inflateArchive` exists to stop.
  const caught = await rejectionOf(openThreeMfArchive(new Blob([strToU8('just a text file, definitely not a zip')])))

  assertUserPresentable(caught)
  assert.match(caught.message, /3MF/)
})
