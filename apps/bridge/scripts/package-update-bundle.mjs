#!/usr/bin/env node
import { createHash, sign } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yazl from 'yazl'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const bridgeRoot = path.resolve(scriptDir, '..')
const repoRoot = path.resolve(bridgeRoot, '../..')
const scriptFilePath = fileURLToPath(import.meta.url)
const EXCLUDED_BUNDLE_FILES = new Set([
  'dist/demo-index.js',
  'dist/demo-index.d.ts',
  'dist/demo-simulator.js',
  'dist/demo-simulator.d.ts'
])

export function resolveUpdateBundleUrl({ bundleName, bundleUrl, baseUrl, apiBaseUrl }) {
  if (bundleUrl) return bundleUrl
  if (baseUrl) {
    return new URL(bundleName, ensureTrailingSlash(baseUrl)).toString()
  }
  if (apiBaseUrl) {
    return new URL(`/api/bridge-runtime/release-assets/${bundleName}`, ensureTrailingSlash(apiBaseUrl)).toString()
  }
  return null
}

export function shouldIncludeUpdateBundleFile(zipPath) {
  return !zipPath.endsWith('.test.js') &&
    !zipPath.endsWith('.test.d.ts') &&
    !EXCLUDED_BUNDLE_FILES.has(zipPath)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const packageJson = JSON.parse(await readFile(path.join(bridgeRoot, 'package.json'), 'utf8'))
  const version = args.version ?? packageJson.version
  const outDir = path.resolve(repoRoot, args.outDir ?? 'apps/bridge/release/update-bundles')
  const bundleName = `bridge-${version}.zip`
  const bundlePath = path.join(outDir, bundleName)
  const bundleUrl = resolveUpdateBundleUrl({
    bundleName,
    bundleUrl: args.bundleUrl,
    baseUrl: args.baseUrl,
    apiBaseUrl: args.apiBaseUrl
  })
  const privateKeyPem = await loadPrivateKey()

  if (!bundleUrl) {
    throw new Error('Provide --bundle-url, --base-url, or --api-base-url so the release JSON can point clients at the bundle.')
  }
  if (!privateKeyPem) {
    throw new Error('Provide BRIDGE_UPDATE_PRIVATE_KEY or BRIDGE_UPDATE_PRIVATE_KEY_FILE for Ed25519 signing.')
  }

  await mkdir(outDir, { recursive: true })
  await createBridgeZip(bundlePath)
  const bytes = await readFile(bundlePath)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const release = {
    channel: args.channel ?? 'stable',
    version,
    protocolVersion: Number(args.protocolVersion ?? process.env.BRIDGE_PROTOCOL_VERSION ?? 1),
    runnerAbiVersion: args.runnerAbiVersion ?? process.env.BRIDGE_RUNNER_ABI_VERSION ?? 'node22-ffmpeg7-v1',
    minimumRunnerAbiVersion: args.minimumRunnerAbiVersion ?? args.runnerAbiVersion ?? process.env.BRIDGE_RUNNER_ABI_VERSION ?? 'node22-ffmpeg7-v1',
    releasedAt: args.releasedAt ?? new Date().toISOString(),
    critical: args.critical === 'true',
    notesUrl: args.notesUrl ?? null,
    bundle: {
      url: bundleUrl,
      sha256,
      signature: sign(null, Buffer.from(sha256, 'utf8'), privateKeyPem).toString('base64'),
      sizeBytes: bytes.byteLength
    }
  }

  const releasePath = path.join(outDir, `bridge-${version}.release.json`)
  await writeFile(releasePath, `${JSON.stringify(release, null, 2)}\n`, 'utf8')
  console.log(`Wrote ${path.relative(repoRoot, bundlePath)}`)
  console.log(`Wrote ${path.relative(repoRoot, releasePath)}`)
}

async function createBridgeZip(targetPath) {
  const zip = new yazl.ZipFile()
  await addDirectoryToZip(zip, path.join(bridgeRoot, 'dist'), 'dist')
  zip.addBuffer(Buffer.from(JSON.stringify({ type: 'module' }, null, 2), 'utf8'), 'package.json')
  zip.end()

  await new Promise((resolve, reject) => {
    const output = createWriteStream(targetPath)
    zip.outputStream.on('error', reject)
    output.on('error', reject)
    output.on('close', resolve)
    zip.outputStream.pipe(output)
  })
}

async function addDirectoryToZip(zip, sourceDir, zipDir) {
  const entries = await readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    const sourcePath = path.join(sourceDir, entry.name)
    const zipPath = `${zipDir}/${entry.name}`
    if (entry.isDirectory()) {
      await addDirectoryToZip(zip, sourcePath, zipPath)
      continue
    }
    if (!entry.isFile() || !shouldIncludeUpdateBundleFile(zipPath)) {
      continue
    }
    const info = await stat(sourcePath)
    zip.addReadStream(createReadStream(sourcePath), zipPath, { mtime: info.mtime })
  }
}

async function loadPrivateKey() {
  if (process.env.BRIDGE_UPDATE_PRIVATE_KEY_FILE) {
    return readFile(process.env.BRIDGE_UPDATE_PRIVATE_KEY_FILE, 'utf8')
  }
  return process.env.BRIDGE_UPDATE_PRIVATE_KEY ?? null
}

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === '--help') {
      parsed.help = true
      continue
    }
    if (!value.startsWith('--')) {
      fail(`Unexpected argument: ${value}`)
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())
    const next = values[index + 1]
    if (!next || next.startsWith('--')) {
      parsed[key] = 'true'
      continue
    }
    parsed[key] = next
    index += 1
  }
  return parsed
}

function ensureTrailingSlash(value) {
  return value.endsWith('/') ? value : `${value}/`
}

function printHelp() {
  console.log(`Usage: npm run package:update-bundle --workspace @printstream/bridge -- --api-base-url https://printstream.app\n\nOptions:\n  --channel <channel>\n  --version <version>\n  --out-dir <path>\n  --bundle-url <url>\n  --base-url <url>\n  --api-base-url <url>\n  --protocol-version <number>\n  --runner-abi-version <version>\n  --minimum-runner-abi-version <version>\n  --notes-url <url>\n  --critical true`)
}

function fail(message) {
  throw new Error(message)
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFilePath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
