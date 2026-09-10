import assert from 'node:assert/strict'
import test from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { readZippedAmfDocument } from './localAmfImport.js'

test('zipped AMF loading prefers the document and does not return a preceding resource', () => {
  const bytes = zipSync({
    'texture.bin': new Uint8Array([1, 2, 3]),
    'model.amf': strToU8('<amf><object id="1"/></amf>')
  })
  assert.equal(readZippedAmfDocument(bytes), '<amf><object id="1"/></amf>')
})

test('zipped AMF loading keeps the extension-less document fallback', () => {
  const bytes = zipSync({ 'document.xml': strToU8('<amf/>'), 'later.bin': new Uint8Array([1]) })
  assert.equal(readZippedAmfDocument(bytes), '<amf/>')
})
