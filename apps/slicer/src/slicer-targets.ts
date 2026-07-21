/**
 * Runtime slicer target registry.
 *
 * The sidecar can host multiple extracted AppImages at once. This module
 * loads the generated target manifest when available and falls back to the
 * legacy single-target env wiring for older containers.
 */
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { accessSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { slicerFamilySchema, slicingTargetDescriptorSchema, type SlicingTargetDescriptor } from '@printstream/shared'
import { z } from 'zod'
import { env } from './env.js'

const runtimeSlicerTargetSchema = slicingTargetDescriptorSchema.extend({
  cliPath: z.string().trim().min(1),
  appDir: z.string().trim().min(1).optional(),
  profileDir: z.string().trim().min(1),
  cliArgsTemplate: z.string().trim().min(1).optional(),
  /** Bundled from a Bambu PRE-release; never selected by default. */
  prerelease: z.boolean().optional()
})

const runtimeSlicerTargetsFileSchema = z.object({
  defaultTargetId: z.string().trim().min(1).nullable().optional(),
  targets: z.array(runtimeSlicerTargetSchema)
})

export type RuntimeSlicerTarget = z.infer<typeof runtimeSlicerTargetSchema>

export interface RuntimeSlicerTargetRegistry {
  defaultTargetId: string | null
  targets: RuntimeSlicerTarget[]
}

let registryPromise: Promise<RuntimeSlicerTargetRegistry> | null = null

const temporarilyDisabledTargetFamilies = new Set<RuntimeSlicerTarget['family']>([
  slicerFamilySchema.enum.orcaslicer
])

export function getSlicerTargetRegistry(): Promise<RuntimeSlicerTargetRegistry> {
  registryPromise ??= loadSlicerTargetRegistry()
  return registryPromise
}

export function getPublicSlicerTargets(registry: RuntimeSlicerTargetRegistry): SlicingTargetDescriptor[] {
  return registry.targets.map(({ id, label, family, version, slicerName, supportsEstimateModeMachineSwitch, isDefault, prerelease }) => ({
    id,
    label,
    family,
    version,
    slicerName,
    supportsEstimateModeMachineSwitch,
    isDefault,
    prerelease: prerelease === true
  }))
}

export function resolveSlicerTarget(registry: RuntimeSlicerTargetRegistry, targetId?: string | null): RuntimeSlicerTarget | null {
  const requestedId = targetId?.trim()
  if (requestedId) {
    return registry.targets.find((target) => target.id === requestedId) ?? null
  }
  const defaultId = registry.defaultTargetId
  if (defaultId) {
    return registry.targets.find((target) => target.id === defaultId) ?? null
  }
  return registry.targets[0] ?? null
}

async function loadSlicerTargetRegistry(): Promise<RuntimeSlicerTargetRegistry> {
  const manifestRegistry = await loadManifestRegistry().catch(() => null)
  if (manifestRegistry) return manifestRegistry
  return loadLegacyRegistry()
}

async function loadManifestRegistry(): Promise<RuntimeSlicerTargetRegistry | null> {
  const raw = readTargetsFile(env.SLICER_TARGETS_FILE)
  if (!raw) return null
  const parsed = runtimeSlicerTargetsFileSchema.safeParse(JSON.parse(raw))
  if (!parsed.success) {
    console.warn('Invalid slicer target manifest', parsed.error.issues[0]?.message ?? 'unknown error')
    return null
  }

  const configuredTargets: RuntimeSlicerTarget[] = []
  for (const target of parsed.data.targets) {
    if (temporarilyDisabledTargetFamilies.has(target.family)) {
      console.warn(`Skipping slicer target ${target.id}: ${target.slicerName} is temporarily disabled in PrintStream`)
      continue
    }
    if (await isRuntimeTargetConfigured(target)) {
      configuredTargets.push({
        ...target,
        supportsEstimateModeMachineSwitch: detectEstimateModeMachineSwitchSupport(target)
      })
    }
  }

  const defaultTargetId = selectDefaultTargetId(configuredTargets, env.SLICER_DEFAULT_TARGET_ID ?? parsed.data.defaultTargetId ?? null)
  return {
    defaultTargetId,
    targets: configuredTargets.map((target) => ({ ...target, isDefault: target.id === defaultTargetId }))
  }
}

function loadLegacyRegistry(): RuntimeSlicerTargetRegistry {
  if (!env.SLICER_CLI_PATH || !env.SLICER_BAMBUSTUDIO_PROFILE_DIR) {
    return { defaultTargetId: null, targets: [] }
  }
  const target: RuntimeSlicerTarget = {
    id: 'legacy-bambustudio',
    label: 'Bambu Studio (legacy)',
    family: slicerFamilySchema.enum.bambustudio,
    version: 'legacy',
    slicerName: 'Bambu Studio',
    supportsEstimateModeMachineSwitch: false,
    isDefault: true,
    cliPath: env.SLICER_CLI_PATH,
    profileDir: env.SLICER_BAMBUSTUDIO_PROFILE_DIR
  }
  return { defaultTargetId: target.id, targets: [target] }
}

function readTargetsFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

function selectDefaultTargetId(targets: RuntimeSlicerTarget[], preferredId: string | null): string | null {
  if (preferredId && targets.some((target) => target.id === preferredId)) return preferredId
  return targets[0]?.id ?? null
}

async function isRuntimeTargetConfigured(target: RuntimeSlicerTarget): Promise<boolean> {
  if (target.appDir) {
    try {
      await access(path.join(target.appDir, 'AppRun'), constants.X_OK)
      const binaryPaths = resolveTargetBinaryPaths(target.appDir)
      for (const binaryPath of binaryPaths) {
        const missingLibraries = getMissingSharedLibraries(binaryPath)
        if (missingLibraries.length > 0) {
          console.warn(
            `Skipping slicer target ${target.id}: missing shared libraries for ${path.basename(binaryPath)}: ${missingLibraries.join(', ')}`
          )
          return false
        }
        const incompatibleRuntimeVersions = getIncompatibleRuntimeVersions(binaryPath)
        if (incompatibleRuntimeVersions.length > 0) {
          console.warn(
            `Skipping slicer target ${target.id}: incompatible runtime requirements for ${path.basename(binaryPath)}: ${incompatibleRuntimeVersions.join(', ')}`
          )
          return false
        }
      }
      return true
    } catch {
      return false
    }
  }
  try {
    await access(target.cliPath, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function resolveTargetBinaryPaths(appDir: string): string[] {
  const candidates = [
    path.join(appDir, 'bin', 'bambu-studio'),
    path.join(appDir, 'bin', 'orca-slicer'),
    path.join(appDir, 'bambu-studio'),
    path.join(appDir, 'orca-slicer'),
    path.join(appDir, 'AppRun')
  ]

  const discovered: string[] = []
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.R_OK)
      discovered.push(candidate)
    } catch {
      // Ignore missing/unreadable candidates and keep probing.
    }
  }
  return discovered
}

function getMissingSharedLibraries(binaryPath: string): string[] {
  const output = probeBinaryRuntime(binaryPath)
  if (!output) return []
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes('=> not found'))
    .map((line) => line.split('=>')[0]?.trim())
    .filter((value): value is string => Boolean(value))
}

function getIncompatibleRuntimeVersions(binaryPath: string): string[] {
  const output = probeBinaryRuntime(binaryPath)
  if (!output) return []
  const versions = output
    .split('\n')
    .map((line) => line.trim())
    .flatMap((line) => {
      const match = line.match(/version `([^']+)' not found/i)
      return match?.[1] ? [match[1]] : []
    })
  return Array.from(new Set(versions))
}

function detectEstimateModeMachineSwitchSupport(target: RuntimeSlicerTarget): boolean {
  const probe = spawnSync(target.cliPath, ['--help'], {
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      SLICER_APPDIR: target.appDir ?? process.env.SLICER_APPDIR
    }
  })
  if (probe.error) return false
  return `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.toLowerCase().includes('--estimate-mode')
}

function probeBinaryRuntime(binaryPath: string): string | null {
  const binaryDir = path.dirname(binaryPath)
  const appDir = path.dirname(binaryDir)
  const existingLdLibraryPath = process.env.LD_LIBRARY_PATH?.trim()
  const ldLibraryPath = [
    binaryDir,
    path.join(appDir, 'lib'),
    path.join(appDir, 'usr', 'lib'),
    existingLdLibraryPath ?? ''
  ]
    .filter((segment) => segment.length > 0)
    .join(':')
  const probe = spawnSync('ldd', [binaryPath], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      LD_LIBRARY_PATH: ldLibraryPath
    }
  })
  if (probe.error) return null
  return `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`
}