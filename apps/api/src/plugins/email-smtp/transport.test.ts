import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encryptSecret } from '../../lib/secret-encryption.js'
import type { PluginSettingStore } from '../../plugin/types.js'
import { createSmtpTransport, readSmtpConfig, type SmtpConfig } from './transport.js'

function memoryStore(initial: Record<string, string> = {}): PluginSettingStore {
  const map = new Map(Object.entries(initial))
  const store: PluginSettingStore = {
    async get(key) { return map.get(key) ?? null },
    async set(key, value) { map.set(key, value) },
    async delete(key) { map.delete(key) },
    forTenant: () => store
  }
  return store
}

test('isConfigured requires host and fromEmail', async () => {
  assert.equal(await createSmtpTransport(memoryStore({})).isConfigured(), false)
  assert.equal(await createSmtpTransport(memoryStore({ host: 'smtp.x' })).isConfigured(), false)
  assert.equal(await createSmtpTransport(memoryStore({ host: 'smtp.x', fromEmail: 'a@x.co' })).isConfigured(), true)
})

test('readSmtpConfig decrypts the stored password and defaults the port', async () => {
  const config = await readSmtpConfig(memoryStore({
    host: 'smtp.example.com',
    fromEmail: 'printstream@example.com',
    username: 'user',
    password: encryptSecret('s3cret')
  }))
  assert.ok(config)
  assert.equal(config?.password, 's3cret')
  assert.equal(config?.port, 587) // non-secure default
  assert.equal((await readSmtpConfig(memoryStore({ host: 'h', fromEmail: 'a@x.co', secure: 'true' })))?.port, 465)
})

test('send formats the From header and forwards the message', async () => {
  const sent: Array<{ config: SmtpConfig; message: Record<string, unknown> }> = []
  const transport = createSmtpTransport(
    memoryStore({ host: 'smtp.example.com', fromEmail: 'printstream@example.com', fromName: 'PrintStream', password: encryptSecret('p') }),
    {
      createTransporter: (config) => ({
        sendMail: async (message) => { sent.push({ config, message }); return undefined }
      })
    }
  )

  await transport.send({ to: 'member@example.com', subject: 'Done', text: 'Job finished', html: '<p>Job finished</p>' })

  assert.equal(sent.length, 1)
  assert.equal(sent[0]?.config.password, 'p')
  assert.deepEqual(sent[0]?.message, {
    from: 'PrintStream <printstream@example.com>',
    to: 'member@example.com',
    subject: 'Done',
    text: 'Job finished',
    html: '<p>Job finished</p>'
  })
})
