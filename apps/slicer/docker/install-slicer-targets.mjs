#!/usr/bin/env node
import { createWriteStream } from 'node:fs'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { generateFullProfiles } from './generate-bambustudio-full-profiles.mjs'
import { slicerTargets } from './slicer-targets.mjs'

const outputRoot = process.argv[2] ?? '/opt/printstream-slicers'
const cliPath = process.argv[3] ?? '/usr/local/bin/slicer-cli'

await rm(outputRoot, { recursive: true, force: true })
await mkdir(outputRoot, { recursive: true })

const manifest = {
  defaultTargetId: slicerTargets.find((target) => target.isDefault)?.id ?? slicerTargets[0]?.id ?? null,
  targets: []
}

for (const target of slicerTargets) {
  const targetRoot = path.join(outputRoot, target.id)
  const downloadPath = path.join(targetRoot, `${target.id}.AppImage`)
  const appDir = path.join(targetRoot, 'app')
  const profileDir = path.join(targetRoot, 'profiles')

  await mkdir(targetRoot, { recursive: true })
  console.log(`Downloading ${target.label}`)
  await downloadFile(target.downloadUrl, downloadPath)
  await extractAppImage(downloadPath, appDir)
  await ensureAppRun(appDir)
  await generateFullProfiles(path.join(appDir, 'resources', 'profiles'), profileDir)
  await rm(downloadPath, { force: true })

  manifest.targets.push({
    id: target.id,
    label: target.label,
    family: target.family,
    version: target.version,
    slicerName: target.slicerName,
    isDefault: target.id === manifest.defaultTargetId,
    cliPath,
    appDir,
    profileDir
  })
}

await writeFile(path.join(outputRoot, 'targets.json'), `${JSON.stringify(manifest, null, 2)}\n`)

async function downloadFile(url, destination) {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }
  await pipeline(Readable.fromWeb(response.body), createWriteStream(destination))
}

async function extractAppImage(appImagePath, appDir) {
  await rm(appDir, { recursive: true, force: true })
  const offsets = execFileSync('grep', ['-abo', 'hsqs', appImagePath], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => Number(line.split(':', 1)[0]))
    .filter((value) => Number.isFinite(value))
  for (const offset of offsets) {
    const result = spawnSync('unsquashfs', ['-q', '-d', appDir, '-o', String(offset), appImagePath], { stdio: 'inherit' })
    if (result.status === 0) return
    await rm(appDir, { recursive: true, force: true })
  }
  throw new Error(`Unable to extract AppImage ${appImagePath}`)
}

async function ensureAppRun(appDir) {
  const appRunPath = path.join(appDir, 'AppRun')
  try {
    await access(appRunPath, constants.X_OK)
  } catch {
    throw new Error(`Missing executable AppRun in ${appDir}`)
  }
}