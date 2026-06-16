import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDocumentTitle, getDeploymentEnvironment } from './deploymentEnvironment.js'

test('getDeploymentEnvironment tags the canonical cloud hosts', () => {
  assert.equal(getDeploymentEnvironment('staging.printstream.app', false), 'staging')
  assert.equal(getDeploymentEnvironment('dev.printstream.app', false), 'dev')
  assert.equal(getDeploymentEnvironment('printstream.app', false), 'production')
})

test('getDeploymentEnvironment treats local dev mode as dev', () => {
  assert.equal(getDeploymentEnvironment('localhost', true), 'dev')
})

test('getDeploymentEnvironment does not tag a self-hoster dev/staging subdomain', () => {
  assert.equal(getDeploymentEnvironment('dev.example.com', false), 'production')
  assert.equal(getDeploymentEnvironment('staging.example.com', false), 'production')
})

test('buildDocumentTitle prefixes only non-production', () => {
  assert.equal(buildDocumentTitle('staging'), '[staging] PrintStream')
  assert.equal(buildDocumentTitle('dev'), '[dev] PrintStream')
  assert.equal(buildDocumentTitle('production'), 'PrintStream')
})
