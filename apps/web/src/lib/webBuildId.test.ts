/** Regression coverage for complete, deterministic browser build identities. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { build } from 'vite'
import { computeWebBuildId, webBuildIdPlugin } from '../../webBuildIdPlugin'
import { WEB_BUILD_ID_META_NAME } from './webBuildId'

test('build identity is stable but changes with HTML, asset bytes or file names', () => {
  const html = { fileName: 'index.html', source: '<head></head>' }
  const script = { fileName: 'assets/app.js', source: 'one' }
  const original = computeWebBuildId([html, script])
  assert.equal(original, computeWebBuildId([script, html]))
  assert.notEqual(original, computeWebBuildId([{ ...html, source: '<head><title>new</title></head>' }, script]))
  assert.notEqual(original, computeWebBuildId([html, { ...script, source: 'two' }]))
  assert.notEqual(original, computeWebBuildId([html, { ...script, fileName: 'assets/new.js' }]))
  assert.throws(() => computeWebBuildId([]), /no emitted assets/)
})

test('real Vite builds stamp matching identities and detect public-only and HTML-only changes', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'web-build-id-'))
  try {
    await mkdir(path.join(directory, 'public'))
    await writeFile(path.join(directory, 'index.html'), '<html><head></head><body><script type="module" src="/main.js"></script></body></html>')
    await writeFile(path.join(directory, 'main.js'), 'console.log("stable app")')
    await writeFile(path.join(directory, 'public', 'icon.svg'), '<svg/>')
    const compile = async (): Promise<string> => {
      await build({ root: directory, configFile: false, logLevel: 'silent', plugins: [webBuildIdPlugin()] })
      const { buildId } = JSON.parse(await readFile(path.join(directory, 'dist', 'build-id.json'), 'utf8')) as { buildId: string }
      const html = await readFile(path.join(directory, 'dist', 'index.html'), 'utf8')
      assert.ok(html.includes(`name="${WEB_BUILD_ID_META_NAME}" content="${buildId}"`))
      return buildId
    }
    const original = await compile()
    assert.equal(await compile(), original, 'identical rebuilds must not bounce clients')
    await writeFile(path.join(directory, 'public', 'icon.svg'), '<svg><path/></svg>')
    const publicChanged = await compile()
    assert.notEqual(publicChanged, original)
    await writeFile(path.join(directory, 'index.html'), '<html><head><title>Changed</title></head><body><script type="module" src="/main.js"></script></body></html>')
    assert.notEqual(await compile(), publicChanged)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
