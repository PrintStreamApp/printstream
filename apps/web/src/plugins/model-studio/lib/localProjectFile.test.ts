import assert from 'node:assert/strict'
import test from 'node:test'
import { installJsdomGlobals } from '../../../test-utils/jsdom'
import {
  localProjectFileFromFile,
  pickLocalProjectFileViaInput,
  openLocalProjectFile,
  saveLocalProjectAs,
  suggestedSaveName,
  supportsFileSystemAccess
} from './localProjectFile'

/** A File System Access handle stub that records what was written to it. */
function fakeHandle(name: string, permission: PermissionState = 'granted') {
  const writes: Uint8Array[] = []
  let closed = 0
  let requested = 0
  return {
    writes,
    closed: () => closed,
    requested: () => requested,
    handle: {
      name,
      queryPermission: async () => permission,
      requestPermission: async () => { requested += 1; return permission === 'granted' ? 'granted' : 'denied' },
      getFile: async () => new File([new Uint8Array([1, 2, 3])], name),
      createWritable: async () => ({
        write: async (data: Blob) => { writes.push(new Uint8Array(await data.arrayBuffer())) },
        close: async () => { closed += 1 }
      })
    }
  }
}

function withPickers<T>(pickers: Record<string, unknown>, run: () => Promise<T>): Promise<T> {
  const target = globalThis as Record<string, unknown>
  const saved = { open: target.showOpenFilePicker, save: target.showSaveFilePicker }
  Object.assign(target, pickers)
  return run().finally(() => {
    if (saved.open === undefined) delete target.showOpenFilePicker; else target.showOpenFilePicker = saved.open
    if (saved.save === undefined) delete target.showSaveFilePicker; else target.showSaveFilePicker = saved.save
  })
}

test('suggestedSaveName keeps a .3mf name and gives one to anything else', () => {
  assert.equal(suggestedSaveName('Bracket.3mf'), 'Bracket.3mf')
  assert.equal(suggestedSaveName('Bracket.STL'), 'Bracket.3mf')
  assert.equal(suggestedSaveName('no extension'), 'no extension.3mf')
  // A name that is only whitespace would otherwise download as ".3mf".
  assert.equal(suggestedSaveName('   '), 'project.3mf')
  // Dots inside the name are not an extension: a looser rule truncated these to "v1.3mf".
  assert.equal(suggestedSaveName('v1.2 bracket'), 'v1.2 bracket.3mf')
  assert.equal(suggestedSaveName('v1.2'), 'v1.2.3mf')
  assert.equal(suggestedSaveName('archive.tar.gz'), 'archive.tar.3mf')
})

test('a dropped file can be edited but never saved in place', () => {
  const project = localProjectFileFromFile(new File([new Uint8Array([1])], 'Dropped.3mf'))
  assert.equal(project.name, 'Dropped.3mf')
  // No writable handle exists for a drop, so the caller must fall back to a download.
  assert.equal(project.saveInPlace, null)
})

test('a picked file saves back to the same handle', async () => {
  const picked = fakeHandle('Picked.3mf')
  await withPickers({ showOpenFilePicker: async () => [picked.handle] }, async () => {
    const project = await openLocalProjectFile()
    assert.ok(project)
    assert.equal(project.name, 'Picked.3mf')
    assert.ok(project.saveInPlace, 'a picked file is writable')

    await project.saveInPlace!(new Uint8Array([9, 9, 9]))
    assert.deepEqual([...picked.writes[0]!], [9, 9, 9])
    // Closing is what commits the write; a skipped close leaves a locked, half-written file.
    assert.equal(picked.closed(), 1)
  })
})

test('a dismissed picker is a normal outcome, not an error', async () => {
  const abort = Object.assign(new Error('user cancelled'), { name: 'AbortError' })
  await withPickers({ showOpenFilePicker: async () => { throw abort } }, async () => {
    assert.equal(await openLocalProjectFile(), null)
  })
  await withPickers({ showSaveFilePicker: async () => { throw abort } }, async () => {
    assert.equal(await saveLocalProjectAs('x.3mf', new Uint8Array()), null)
  })
})

test('a genuine picker failure propagates rather than looking like a cancel', async () => {
  await withPickers({ showOpenFilePicker: async () => { throw new Error('disk on fire') } }, async () => {
    await assert.rejects(() => openLocalProjectFile(), /disk on fire/)
  })
})

test('save-as returns a project that subsequent saves overwrite', async () => {
  const chosen = fakeHandle('Chosen.3mf')
  await withPickers({ showSaveFilePicker: async () => chosen.handle }, async () => {
    const project = await saveLocalProjectAs('Suggested.3mf', new Uint8Array([4]))
    assert.ok(project)
    // The name follows the handle the user actually chose, not what we suggested.
    assert.equal(project.name, 'Chosen.3mf')
    await project.saveInPlace!(new Uint8Array([5]))
    assert.deepEqual(picked(chosen.writes), [[4], [5]])
  })
})

test('supportsFileSystemAccess needs both pickers, not just one', async () => {
  await withPickers({ showOpenFilePicker: async () => [], showSaveFilePicker: async () => ({}) }, async () => {
    assert.equal(supportsFileSystemAccess(), true)
  })
  await withPickers({ showOpenFilePicker: async () => [], showSaveFilePicker: undefined }, async () => {
    assert.equal(supportsFileSystemAccess(), false)
  })
})

function picked(writes: Uint8Array[]): number[][] {
  return writes.map((entry) => [...entry])
}

test('the input fallback keeps its element alive until the user answers', async () => {
  // A DETACHED input is collectable the moment the picker call returns, taking its change listener
  // with it: the user picks a file and nothing happens, with no error to explain why. This is the
  // regression that made "I chose a file and nothing happened" possible.
  const { window } = installJsdomGlobals()
  try {
    const pending = pickLocalProjectFileViaInput()
    const input = window.document.querySelector('input[type=file]')
    assert.ok(input, 'the input is attached to the document while the dialog is open')

    Object.defineProperty(input, 'files', { value: [new window.File([new Uint8Array([1])], 'Picked.3mf')] })
    input!.dispatchEvent(new window.Event('change'))

    const picked = await pending
    assert.equal(picked?.name, 'Picked.3mf')
    assert.equal(picked?.saveInPlace, null, 'an input-picked file has no writable handle')
    assert.equal(window.document.querySelector('input[type=file]'), null, 'and is cleaned up after')
  } finally {
    window.close()
  }
})

test('a dismissed input fallback resolves rather than hanging', async () => {
  const { window } = installJsdomGlobals()
  try {
    const pending = pickLocalProjectFileViaInput()
    const input = window.document.querySelector('input[type=file]')
    input!.dispatchEvent(new window.Event('cancel'))
    assert.equal(await pending, null)
    assert.equal(window.document.querySelector('input[type=file]'), null)
  } finally {
    window.close()
  }
})

test('writing an opened file asks for write permission when it only has read', async () => {
  // A handle from showOpenFilePicker carries READ permission only. Without an explicit readwrite
  // request the first Save fails with NotAllowedError, which is what "Save doesn't work" looked like.
  const granted = fakeHandle('Picked.3mf', 'prompt')
  await withPickers({ showOpenFilePicker: async () => [granted.handle] }, async () => {
    const project = await openLocalProjectFile()
    await assert.rejects(() => project!.saveInPlace!(new Uint8Array([1])), /permission/i)
    assert.equal(granted.requested(), 1, 'it asks rather than failing silently')
    assert.equal(granted.writes.length, 0, 'and writes nothing when refused')
  })
})

test('an already-granted handle writes without re-prompting', async () => {
  const ready = fakeHandle('Picked.3mf', 'granted')
  await withPickers({ showOpenFilePicker: async () => [ready.handle] }, async () => {
    const project = await openLocalProjectFile()
    await project!.saveInPlace!(new Uint8Array([7]))
    assert.deepEqual([...ready.writes[0]!], [7])
    assert.equal(ready.requested(), 0, 'no prompt when permission is already held')
  })
})
