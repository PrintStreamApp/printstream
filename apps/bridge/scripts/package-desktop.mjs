import { spawn, spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const electronBuilderCliPath = require.resolve('electron-builder/out/cli/cli.js')
const scriptFilePath = fileURLToPath(import.meta.url)
const scriptDir = path.dirname(scriptFilePath)
const projectDir = path.resolve(scriptDir, '..')
const SUPPORTED_ARCHES = new Set(['x64', 'arm64'])

export function computePackagingPlan({
  platform = process.platform,
  arch = normalizeArch(process.arch),
  availableCommands = defaultAvailableCommands(platform)
} = {}) {
  const linuxTargets = ['tar.gz']
  const windowsTargets = []
  const macTargets = []
  const warnings = []
  const unsupported = []

  const hasDpkg = availableCommands.has('dpkg')
  const hasWine = availableCommands.has('wine')
  const hasMakensis = availableCommands.has('makensis')
  const hasXorriso = availableCommands.has('xorriso')
  const hasMksquashfs = availableCommands.has('mksquashfs')

  if (platform === 'linux') {
    if (hasDpkg) {
      linuxTargets.push('deb')
    } else {
      warnings.push('Skipping Linux deb output because dpkg is not installed.')
    }

    if (hasXorriso && hasMksquashfs) {
      linuxTargets.unshift('AppImage')
    } else {
      const missing = ['xorriso', 'mksquashfs'].filter((command) => !availableCommands.has(command))
      warnings.push(`Skipping Linux AppImage output because ${missing.join(' and ')} ${missing.length === 1 ? 'is' : 'are'} not installed.`)
    }

    if (hasWine) {
      windowsTargets.push('portable')
      if (hasMakensis) {
        windowsTargets.push('nsis')
      } else {
        warnings.push('Skipping Windows NSIS output because makensis is not installed.')
      }
    } else {
      warnings.push('Skipping Windows output because wine is not installed.')
    }

    unsupported.push('macOS packages require a macOS host; Electron cannot produce dmg bundles from Linux.')
  }

  if (platform === 'darwin') {
    macTargets.push('zip', 'dmg')
    unsupported.push('Windows packages are not enabled by this repo script on macOS.')
  }

  if (platform === 'win32') {
    windowsTargets.push('portable', 'nsis')
    unsupported.push('macOS packages require a macOS host; Electron cannot produce dmg bundles from Windows.')
  }

  if (!['linux', 'darwin', 'win32'].includes(platform)) {
    unsupported.push(`Unsupported packaging host platform: ${platform}.`)
  }

  return {
    platform,
    arch,
    linuxTargets,
    windowsTargets,
    macTargets,
    warnings,
    unsupported
  }
}

function defaultAvailableCommands(platform) {
  const commands = ['dpkg', 'wine', 'makensis', 'xorriso', 'mksquashfs']
  return new Set(commands.filter((command) => commandExists(command, platform)))
}

function commandExists(command, platform) {
  const probe = platform === 'win32' ? 'where' : 'which'
  const result = spawnSync(probe, [command], { stdio: 'ignore' })
  return result.status === 0
}

function printPlan(plan) {
  console.log(`Bridge desktop packaging plan for ${plan.platform}/${plan.arch}`)
  console.log(`Linux targets: ${plan.linuxTargets.length > 0 ? plan.linuxTargets.join(', ') : 'none'}`)
  console.log(`Windows targets: ${plan.windowsTargets.length > 0 ? plan.windowsTargets.join(', ') : 'none'}`)
  console.log(`macOS targets: ${plan.macTargets.length > 0 ? plan.macTargets.join(', ') : 'none'}`)

  if (plan.warnings.length > 0) {
    console.log('Warnings:')
    for (const warning of plan.warnings) {
      console.log(`- ${warning}`)
    }
  }

  if (plan.unsupported.length > 0) {
    console.log('Unsupported:')
    for (const detail of plan.unsupported) {
      console.log(`- ${detail}`)
    }
  }
}

async function runRequestedBuild(request, requestedArch) {
  const arch = normalizeRequestedArch(requestedArch)
  const plan = computePackagingPlan({ arch })

  if (request === 'plan') {
    printPlan(plan)
    return
  }

  if (request === 'dir') {
    await runElectronBuilder(['--dir', `--${plan.arch}`])
    return
  }

  if (request === 'appimage') {
    ensureTarget(plan.linuxTargets, 'AppImage', 'AppImage', plan)
    await runElectronBuilder(['--linux', 'AppImage', `--${plan.arch}`])
    return
  }

  if (request === 'host') {
    if (plan.platform === 'linux') {
      await runElectronBuilder(['--linux', ...plan.linuxTargets, `--${plan.arch}`])
      return
    }
    if (plan.platform === 'darwin') {
      await runElectronBuilder(['--mac', ...plan.macTargets, `--${plan.arch}`])
      return
    }
    if (plan.platform === 'win32') {
      await runElectronBuilder(['--win', ...plan.windowsTargets, `--${plan.arch}`])
      return
    }
    throw new Error(`Unsupported packaging host platform: ${plan.platform}.`)
  }

  if (request === 'all-supported') {
    if (plan.platform === 'linux') {
      await runElectronBuilder(['--linux', ...plan.linuxTargets, `--${plan.arch}`])
      if (plan.windowsTargets.length > 0) {
        await runElectronBuilder(['--win', ...plan.windowsTargets, `--${plan.arch}`])
      }
      return
    }

    await runRequestedBuild('host', plan.arch)
    return
  }

  if (request === 'linux-all') {
    for (const targetArch of SUPPORTED_ARCHES) {
      await runRequestedBuild('linux', targetArch)
    }
    return
  }

  if (request === 'win-all') {
    for (const targetArch of SUPPORTED_ARCHES) {
      await runRequestedBuild('win', targetArch)
    }
    return
  }

  if (request === 'linux') {
    ensureTargets(plan.linuxTargets, 'linux', plan)
    await runElectronBuilder(['--linux', ...plan.linuxTargets, `--${plan.arch}`])
    return
  }

  if (request === 'win') {
    ensureTargets(plan.windowsTargets, 'Windows', plan)
    await runElectronBuilder(['--win', ...plan.windowsTargets, `--${plan.arch}`])
    return
  }

  if (request === 'mac') {
    ensureTargets(plan.macTargets, 'macOS', plan)
    await runElectronBuilder(['--mac', ...plan.macTargets, `--${plan.arch}`])
    return
  }

  throw new Error(`Unknown bridge packaging command: ${request}.`)
}

function ensureTargets(targets, label, plan) {
  if (targets.length > 0) {
    return
  }

  const lines = [`No ${label} bridge packaging targets are available on ${plan.platform}/${plan.arch}.`]
  for (const warning of plan.warnings) {
    lines.push(`- ${warning}`)
  }
  for (const detail of plan.unsupported) {
    lines.push(`- ${detail}`)
  }
  throw new Error(lines.join('\n'))
}

function ensureTarget(targets, target, label, plan) {
  if (targets.includes(target)) {
    return
  }

  const lines = [`No ${label} bridge packaging target is available on ${plan.platform}/${plan.arch}.`]
  for (const warning of plan.warnings) {
    lines.push(`- ${warning}`)
  }
  for (const detail of plan.unsupported) {
    lines.push(`- ${detail}`)
  }
  throw new Error(lines.join('\n'))
}

async function runElectronBuilder(args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [electronBuilderCliPath, ...args], {
      cwd: projectDir,
      stdio: 'inherit',
      env: process.env
    })

    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`electron-builder exited with status ${code ?? 'unknown'}.`))
    })
  })
}

function normalizeRequestedArch(value) {
  if (!value) {
    return normalizeArch(process.arch)
  }

  const normalized = normalizeArch(value)
  if (!SUPPORTED_ARCHES.has(normalized)) {
    throw new Error(`Unsupported bridge packaging architecture: ${value}. Use one of: ${Array.from(SUPPORTED_ARCHES).join(', ')}.`)
  }
  return normalized
}

function normalizeArch(value) {
  if (value === 'aarch64') {
    return 'arm64'
  }
  return value
}

async function main() {
  const request = process.argv[2] ?? 'plan'
  const requestedArch = process.argv[3]
  await runRequestedBuild(request, requestedArch)
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFilePath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}