import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { installJsdomGlobals } from '../test-utils/jsdom'
import { downloadAndImportFromModelProvider, nativeModelImportProviders } from './bridge'

const dom = installJsdomGlobals()
afterEach(() => {
  delete window.__printstreamChooseModelDestination
  delete (window as unknown as { PrintStreamDesktop?: unknown }).PrintStreamDesktop
})

function host(request: (method: string, options?: unknown) => Promise<unknown>, destinationSelection = true) {
  Object.assign(window, {
    PrintStreamDesktop: {
      version: 1,
      capabilities: { modelBrowserImport: ['makerworld', 'printables'], modelImportDestination: destinationSelection },
      request
    }
  })
}

test('older desktop builds cannot silently save using the former destination setting', async () => {
  host(async () => ({}), false)
  assert.deepEqual(await nativeModelImportProviders(), [])
  host(async () => ({}))
  assert.deepEqual(await nativeModelImportProviders(), ['makerworld', 'printables'])
})

test('native captures ask separately for each model and remove the callback when browsing ends', async () => {
  const selections: unknown[] = []
  host(async () => {
    selections.push(await window.__printstreamChooseModelDestination!('cancelled.3mf'))
    selections.push(await window.__printstreamChooseModelDestination!('saved.gcode.3mf'))
    return { file: { id: 'saved' }, openAfterImport: 'model-studio' }
  })
  const names: string[] = []
  const result = await downloadAndImportFromModelProvider({
    provider: 'makerworld', modelUrl: 'https://makerworld.com/en/3d-models', workspace: 'alpha',
    bridgeId: 'initial', folderId: 'initial-folder', defaultFolderName: 'Imported models', promptForDestination: true
  }, async (name) => {
    names.push(name)
    return name === 'cancelled.3mf' ? null : { bridgeId: 'chosen', folderId: null, outputFileName: 'My model' }
  })
  assert.deepEqual(names, ['cancelled.3mf', 'saved.gcode.3mf'])
  assert.deepEqual(selections, [null, { bridgeId: 'chosen', folderId: null, outputFileName: 'My model', fileName: 'My model.gcode.3mf' }])
  assert.deepEqual(result, { file: { id: 'saved' }, openAfterImport: 'model-studio' })
  assert.equal(window.__printstreamChooseModelDestination, undefined)
})

test('a cancelled native browser clears the handoff callback', async () => {
  host(async () => { throw new Error('The Printables download was cancelled.') })
  assert.deepEqual(await downloadAndImportFromModelProvider({
    provider: 'printables', modelUrl: 'https://www.printables.com/model', workspace: 'alpha',
    bridgeId: 'initial', folderId: null, defaultFolderName: 'Imported models', promptForDestination: true
  }, async () => null), { cancelled: true })
  assert.equal(window.__printstreamChooseModelDestination, undefined)
})

// Closing jsdom after all tests avoids retaining its browser resources.
const { after } = await import('node:test')
after(() => { dom.window.close() })
