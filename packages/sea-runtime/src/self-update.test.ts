import assert from 'node:assert/strict'
import { generateKeyPairSync, createHash, sign } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import {
  clearStaleHoldBack,
  confirmSelfUpdateHealthy,
  downloadVerifiedExecutable,
  noteBootAttemptAndMaybeRollback,
  readHeldBackFingerprint,
  readSelfUpdateState,
  rollbackSelfUpdate,
  swapExecutableInPlace,
  writeSelfUpdateState
} from './self-update.js'

const OLD_BINARY = Buffer.from('old-binary-build-a')
const NEW_BINARY = Buffer.from('new-binary-build-b')

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()

function signedSha256(bytes: Buffer): { sha256: string; signature: string } {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return { sha256, signature: sign(null, Buffer.from(sha256, 'utf8'), privateKey).toString('base64') }
}

async function makeInstall(): Promise<{ dir: string; exePath: string; updateStateFile: string; heldBackFile: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sea-self-update-'))
  const exePath = path.join(dir, 'app')
  await writeFile(exePath, OLD_BINARY, { mode: 0o755 })
  return {
    dir,
    exePath,
    updateStateFile: path.join(dir, 'self-update.json'),
    heldBackFile: path.join(dir, 'update-held-back.json')
  }
}

function responseOf(bytes: Buffer): () => Promise<Response> {
  return async () => new Response(new Uint8Array(bytes), { status: 200 })
}

test('downloadVerifiedExecutable writes a verified binary to the target path', async () => {
  const install = await makeInstall()
  try {
    const { sha256, signature } = signedSha256(NEW_BINARY)
    const targetPath = `${install.exePath}.new`
    await downloadVerifiedExecutable({
      fetchResponse: responseOf(NEW_BINARY),
      targetPath,
      sha256,
      sizeBytes: NEW_BINARY.byteLength,
      signature,
      publicKeyPem,
      artifactName: 'App update binary'
    })
    assert.deepEqual(await readFile(targetPath), NEW_BINARY)
  } finally {
    await rm(install.dir, { recursive: true, force: true })
  }
})

test('downloadVerifiedExecutable decompresses gzip assets before verifying', async () => {
  const install = await makeInstall()
  try {
    const { sha256, signature } = signedSha256(NEW_BINARY)
    const targetPath = `${install.exePath}.new`
    await downloadVerifiedExecutable({
      fetchResponse: responseOf(gzipSync(NEW_BINARY)),
      targetPath,
      sha256,
      sizeBytes: NEW_BINARY.byteLength,
      signature,
      publicKeyPem,
      compression: 'gzip',
      artifactName: 'App update binary'
    })
    assert.deepEqual(await readFile(targetPath), NEW_BINARY)
  } finally {
    await rm(install.dir, { recursive: true, force: true })
  }
})

test('downloadVerifiedExecutable removes the partial file on checksum, size, or signature failure', async () => {
  const install = await makeInstall()
  try {
    const targetPath = `${install.exePath}.new`
    const good = signedSha256(NEW_BINARY)

    // Tampered bytes: fails on size first, then checksum for same-length bytes.
    await assert.rejects(() => downloadVerifiedExecutable({
      fetchResponse: responseOf(Buffer.from('tampered-bytes!!!!')),
      targetPath,
      sha256: good.sha256,
      sizeBytes: NEW_BINARY.byteLength,
      signature: good.signature,
      publicKeyPem,
      artifactName: 'App update binary'
    }), /checksum|size/)
    await assert.rejects(() => stat(targetPath))

    // Untrusted signer.
    const rogue = generateKeyPairSync('ed25519')
    await assert.rejects(() => downloadVerifiedExecutable({
      fetchResponse: responseOf(NEW_BINARY),
      targetPath,
      sha256: good.sha256,
      sizeBytes: NEW_BINARY.byteLength,
      signature: sign(null, Buffer.from(good.sha256, 'utf8'), rogue.privateKey).toString('base64'),
      publicKeyPem,
      artifactName: 'App update binary'
    }), /signature is invalid/)
    await assert.rejects(() => stat(targetPath))

    // Missing trust root refuses rather than skipping verification.
    await assert.rejects(() => downloadVerifiedExecutable({
      fetchResponse: responseOf(NEW_BINARY),
      targetPath,
      sha256: good.sha256,
      sizeBytes: NEW_BINARY.byteLength,
      signature: good.signature,
      publicKeyPem: undefined,
      artifactName: 'App update binary'
    }), /public key is not configured/)
  } finally {
    await rm(install.dir, { recursive: true, force: true })
  }
})

test('swapExecutableInPlace backs up the old binary and restores it on failure', async () => {
  const install = await makeInstall()
  try {
    const newPath = `${install.exePath}.new`
    await writeFile(newPath, NEW_BINARY, { mode: 0o755 })
    const backupPath = await swapExecutableInPlace({ exePath: install.exePath, newFilePath: newPath })
    assert.deepEqual(await readFile(install.exePath), NEW_BINARY)
    assert.deepEqual(await readFile(backupPath), OLD_BINARY)

    // A missing replacement restores the original.
    await assert.rejects(() => swapExecutableInPlace({
      exePath: install.exePath,
      newFilePath: path.join(install.dir, 'does-not-exist')
    }))
    assert.deepEqual(await readFile(install.exePath), NEW_BINARY)
  } finally {
    await rm(install.dir, { recursive: true, force: true })
  }
})

test('crash-looping boots roll back and hold the failed build back', async () => {
  const install = await makeInstall()
  try {
    const newPath = `${install.exePath}.new`
    await writeFile(newPath, NEW_BINARY, { mode: 0o755 })
    const backupPath = await swapExecutableInPlace({ exePath: install.exePath, newFilePath: newPath })
    await writeSelfUpdateState(install.updateStateFile, {
      fromFingerprint: 'a'.repeat(64),
      toFingerprint: 'b'.repeat(64),
      updatedAt: new Date().toISOString(),
      bootAttempts: 0,
      backupPath
    })

    const attempt = () => noteBootAttemptAndMaybeRollback({
      updateStateFile: install.updateStateFile,
      heldBackFile: install.heldBackFile,
      exePath: install.exePath,
      maxAttempts: 2
    })
    assert.equal(await attempt(), 'counted')
    assert.equal((await readSelfUpdateState(install.updateStateFile))?.bootAttempts, 1)
    assert.equal(await attempt(), 'counted')
    assert.equal(await attempt(), 'rolled-back')
    assert.deepEqual(await readFile(install.exePath), OLD_BINARY)
    assert.equal(await readHeldBackFingerprint(install.heldBackFile), 'b'.repeat(64))
    assert.equal(await attempt(), 'no-pending-update')
  } finally {
    await rm(install.dir, { recursive: true, force: true })
  }
})

test('a healthy confirmation finalizes the update and drops the backup', async () => {
  const install = await makeInstall()
  try {
    const newPath = `${install.exePath}.new`
    await writeFile(newPath, NEW_BINARY, { mode: 0o755 })
    const backupPath = await swapExecutableInPlace({ exePath: install.exePath, newFilePath: newPath })
    await writeSelfUpdateState(install.updateStateFile, {
      fromFingerprint: 'a'.repeat(64),
      toFingerprint: 'b'.repeat(64),
      updatedAt: new Date().toISOString(),
      bootAttempts: 1,
      backupPath
    })
    assert.equal(await confirmSelfUpdateHealthy({ updateStateFile: install.updateStateFile, exePath: install.exePath }), true)
    await assert.rejects(() => stat(install.updateStateFile))
    await assert.rejects(() => stat(backupPath))

    assert.equal(await confirmSelfUpdateHealthy({ updateStateFile: install.updateStateFile, exePath: install.exePath }), false)
  } finally {
    await rm(install.dir, { recursive: true, force: true })
  }
})

test('rollbackSelfUpdate restores the backup and refuses without one', async () => {
  const install = await makeInstall()
  try {
    await assert.rejects(
      () => rollbackSelfUpdate({ exePath: install.exePath, updateStateFile: install.updateStateFile, heldBackFile: install.heldBackFile }),
      /No previous binary/
    )

    const newPath = `${install.exePath}.new`
    await writeFile(newPath, NEW_BINARY, { mode: 0o755 })
    const backupPath = await swapExecutableInPlace({ exePath: install.exePath, newFilePath: newPath })
    await writeSelfUpdateState(install.updateStateFile, {
      fromFingerprint: 'a'.repeat(64),
      toFingerprint: 'b'.repeat(64),
      updatedAt: new Date().toISOString(),
      bootAttempts: 0,
      backupPath
    })
    await rollbackSelfUpdate({ exePath: install.exePath, updateStateFile: install.updateStateFile, heldBackFile: install.heldBackFile })
    assert.deepEqual(await readFile(install.exePath), OLD_BINARY)
    assert.equal(await readHeldBackFingerprint(install.heldBackFile), 'b'.repeat(64))
    await assert.rejects(() => stat(install.updateStateFile))
  } finally {
    await rm(install.dir, { recursive: true, force: true })
  }
})

test('clearStaleHoldBack drops a hold-back only when the channel moved on', async () => {
  const install = await makeInstall()
  try {
    await writeFile(install.heldBackFile, JSON.stringify({ sourceFingerprint: 'b'.repeat(64) }), 'utf8')
    await clearStaleHoldBack(install.heldBackFile, 'b'.repeat(64))
    assert.equal(await readHeldBackFingerprint(install.heldBackFile), 'b'.repeat(64))
    await clearStaleHoldBack(install.heldBackFile, 'c'.repeat(64))
    assert.equal(await readHeldBackFingerprint(install.heldBackFile), null)
  } finally {
    await rm(install.dir, { recursive: true, force: true })
  }
})
