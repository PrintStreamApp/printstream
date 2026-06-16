/**
 * Regression tests for the private module loader: a missing directory must
 * be a silent no-op (public builds), and discovered modules must be able to
 * mount routes on the app.
 */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import express from 'express'
import { registerPrivateModules } from './private-modules.js'

test('registerPrivateModules is a no-op when the private directory is missing', async () => {
  const app = express()
  const registered = await registerPrivateModules(app, path.join(os.tmpdir(), 'printstream-no-such-dir'))
  assert.deepEqual(registered, [])
})

test('registerPrivateModules mounts discovered modules', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'printstream-private-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const moduleDir = path.join(dir, 'sample')
  await mkdir(moduleDir)
  await writeFile(
    path.join(moduleDir, 'index.js'),
    "export default { name: 'sample', register(app) { app.get('/api/private-sample', (request, response) => response.json({ ok: true })) } }\n"
  )

  const app = express()
  const registered = await registerPrivateModules(app, dir)
  assert.deepEqual(registered, ['sample'])

  const server = app.listen(0)
  t.after(() => server.close())
  const { port } = server.address() as { port: number }
  const response = await fetch(`http://127.0.0.1:${port}/api/private-sample`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true })
})

test('registerPrivateModules rejects modules without a register function', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'printstream-private-'))
  t.after(() => rm(dir, { recursive: true, force: true }))

  const moduleDir = path.join(dir, 'broken')
  await mkdir(moduleDir)
  await writeFile(path.join(moduleDir, 'index.js'), 'export default { name: "broken" }\n')

  await assert.rejects(
    registerPrivateModules(express(), dir),
    /must default-export a PrivateApiModule/
  )
})
