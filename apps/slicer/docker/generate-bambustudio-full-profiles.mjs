#!/usr/bin/env node
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const profilesRoot = process.argv[2]
const outputRoot = process.argv[3] ?? profilesRoot

const profileSets = [
  { source: 'machine', target: 'machine_full' },
  { source: 'process', target: 'process_full' },
  { source: 'filament', target: 'filament_full' }
]

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!profilesRoot) {
    console.error('Usage: generate-bambustudio-full-profiles.mjs <resources/profiles> [outputDir]')
    process.exit(2)
  }
  await generateFullProfiles(profilesRoot, outputRoot)
}

export async function generateFullProfiles(profilesRoot, outputDir = profilesRoot) {
  for (const profileSet of profileSets) {
    const sourceDirs = await findProfileSourceDirs(profilesRoot, profileSet.source)
    const targetDir = path.join(outputDir, profileSet.target)
    const { vendorScopes, globalByName } = await loadProfiles(sourceDirs)
    await rm(targetDir, { recursive: true, force: true })
    await mkdir(targetDir, { recursive: true })

    const seenFiles = new Set()
    let written = 0
    for (const scope of vendorScopes) {
      for (const profile of scope.profiles) {
        if (seenFiles.has(profile.filePath)) continue
        seenFiles.add(profile.filePath)

        // Bake the `inherits` chain's value keys (layer_height,
        // compatible_printers, etc.) into the leaf so process_full readers (the
        // editor resolve endpoint and metadata extraction) see the full
        // effective config. Resolution stays inside the owning vendor first so
        // shared template names that every vendor ships (e.g.
        // `fdm_process_common`) never collide across vendors in the flat output.
        const effective = resolveInheritsWithinScope(profile, scope.byName, globalByName, new Set())
        const output = { ...effective }
        // Preserve only the leaf's own structural directives so the BambuStudio
        // CLI still resolves the chain against its intact bundle at slice time,
        // and a base's `include`/`inherits` never leak in (which would
        // duplicate included gcode fragments).
        restoreLeafField(output, profile.json, 'inherits')
        restoreLeafField(output, profile.json, 'include')
        if (typeof output.from !== 'string' || output.from.length === 0) {
          output.from = 'system'
        }
        const outputName = sanitizeFileName(output.name ?? profile.name)
        await writeFile(path.join(targetDir, `${outputName}.json`), `${JSON.stringify(output, null, 4)}\n`)
        written += 1
      }
    }
    console.log(`Generated ${written} ${profileSet.target} presets`)
  }
}

/**
 * Loads every profile grouped by its owning vendor source dir. Each scope keeps
 * a name→profile map for in-vendor `inherits` resolution; a flat `globalByName`
 * map (first writer wins) is returned only as a fallback for the rare profile
 * that inherits from a template outside its own vendor dir.
 */
async function loadProfiles(sourceDirs) {
  const vendorScopes = []
  const globalByName = new Map()
  for (const sourceDir of sourceDirs) {
    const files = await listJsonFiles(sourceDir)
    const byName = new Map()
    const profiles = []
    for (const filePath of files) {
      const raw = await readFile(filePath, 'utf8')
      const parsed = JSON.parse(raw)
      const fallbackName = path.basename(filePath, '.json')
      const name = typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : fallbackName
      const profile = { name, filePath, json: parsed }
      byName.set(name, profile)
      byName.set(fallbackName, profile)
      if (!globalByName.has(name)) globalByName.set(name, profile)
      if (!globalByName.has(fallbackName)) globalByName.set(fallbackName, profile)
      profiles.push(profile)
    }
    vendorScopes.push({ byName, profiles })
  }
  return { vendorScopes, globalByName }
}

/**
 * Recursively merges a profile's `inherits` chain into a single effective
 * config. The base is resolved first and the child's own keys win. Lookups
 * prefer the owning vendor scope, falling back to the global map only when a
 * referenced base is not present in the same vendor.
 */
function resolveInheritsWithinScope(profile, scopeByName, globalByName, visited) {
  const json = profile.json
  const inherits = typeof json.inherits === 'string' ? json.inherits.trim() : ''
  if (!inherits || visited.has(inherits)) return { ...json }
  visited.add(inherits)
  const base = scopeByName.get(inherits) ?? globalByName.get(inherits)
  if (!base) return { ...json }
  const resolvedBase = resolveInheritsWithinScope(base, scopeByName, globalByName, visited)
  return { ...resolvedBase, ...json }
}

/**
 * Forces a structural directive on the baked output to match the leaf profile:
 * keeps the leaf's own value when present, otherwise drops a value inherited
 * from a base so it does not survive into the flattened preset.
 */
function restoreLeafField(output, leafJson, key) {
  if (Object.prototype.hasOwnProperty.call(leafJson, key)) {
    output[key] = leafJson[key]
  } else {
    delete output[key]
  }
}

async function findProfileSourceDirs(directory, kind) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  const matches = []
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name)
    if (!entry.isDirectory()) continue
    if (entry.name === kind) {
      matches.push(entryPath)
      continue
    }
    matches.push(...await findProfileSourceDirs(entryPath, kind))
  }
  return matches.sort((left, right) => left.localeCompare(right))
}

async function listJsonFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listJsonFiles(filePath))
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
      files.push(filePath)
    }
  }
  return files.sort((left, right) => left.localeCompare(right))
}

function sanitizeFileName(value) {
  return String(value).replace(/[\\/]/g, '-')
}