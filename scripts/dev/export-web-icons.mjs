import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(scriptDir, '../..')
const publicDir = path.join(repoRoot, 'apps', 'web', 'public')
const iconSourceSvg = path.join(publicDir, 'icon.svg')
const maskableSourceSvg = path.join(publicDir, 'maskable-icon.svg')
const brandBackdrop = '#0d1322'

const assets = [
  {
    key: 'icon',
    sourcePath: iconSourceSvg,
    sourceLabel: 'apps/web/public/icon.svg',
    outputs: [
      { outputName: 'icon-1024.png', size: 1024, fit: 0.86, background: 'none' },
      { outputName: 'icon-512.png', size: 512, fit: 0.86, background: 'none' },
      { outputName: 'icon-192.png', size: 192, fit: 0.86, background: 'none' },
      { outputName: 'apple-touch-icon.png', size: 180, fit: 0.84, background: brandBackdrop }
    ]
  },
  {
    key: 'maskable-icon',
    sourcePath: maskableSourceSvg,
    sourceLabel: 'apps/web/public/maskable-icon.svg',
    trim: false,
    outputs: [
      { outputName: 'maskable-icon-512.png', size: 512, fit: 1, background: brandBackdrop },
      { outputName: 'maskable-icon-192.png', size: 192, fit: 1, background: brandBackdrop }
    ]
  }
]

function runCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: publicDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options
  }).trim()
}

function ensureBinary(command) {
  try {
    runCommand('command', ['-v', command], { shell: true })
  } catch {
    process.stderr.write(`Missing required command: ${command}\n`)
    process.exit(1)
  }
}

function resolveSourcePath(asset) {
  const sourcePath = asset.sourcePath
  if (!existsSync(sourcePath)) {
    process.stderr.write(`Missing SVG source: ${path.relative(repoRoot, sourcePath)}\n`)
    process.exit(1)
  }
  return sourcePath
}

function readImageSize(fileName) {
  const output = runCommand('identify', ['-format', '%w %h', fileName])
  const [widthText, heightText] = output.split(' ')
  const width = Number.parseInt(widthText, 10)
  const height = Number.parseInt(heightText, 10)

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    process.stderr.write(`Could not determine image size for ${fileName}.\n`)
    process.exit(1)
  }

  return { width, height }
}

function formatFitLabel(output) {
  return `${Math.round(output.fit * 100)}% fit on ${output.background === 'none' ? 'transparent' : output.background} background`
}

function exportAsset(asset) {
  const sourcePath = resolveSourcePath(asset)
  const sourceName = path.basename(sourcePath)
  const baseName = asset.key
  const renderName = `${baseName}-render.png`
  const trimmedName = `${baseName}-trimmed.png`
  const resizedName = `${baseName}-resized.png`
  const workingName = asset.trim === false ? renderName : trimmedName

  process.stdout.write(`Exporting ${asset.sourceLabel ?? sourceName} for ${asset.key}.\n`)

  runCommand('convert', ['-background', 'none', sourcePath, `PNG32:${renderName}`])
  if (asset.trim === false) {
    const renderSize = readImageSize(renderName)
    process.stdout.write(`  Preserving source bounds: ${renderSize.width}x${renderSize.height}\n`)
  } else {
    runCommand('convert', [renderName, '-trim', '+repage', `PNG32:${trimmedName}`])

    const trimmedSize = readImageSize(trimmedName)
    process.stdout.write(`  Trimmed source bounds: ${trimmedSize.width}x${trimmedSize.height}\n`)
  }

  try {
    for (const output of asset.outputs) {
      const targetSize = Math.max(1, Math.round(output.size * output.fit))
      runCommand('convert', [
        workingName,
        '-resize',
        `${targetSize}x${targetSize}`,
        '-background',
        output.background,
        '-gravity',
        'center',
        '-extent',
        `${output.size}x${output.size}`,
        `PNG32:${resizedName}`
      ])
      runCommand('cp', [resizedName, output.outputName])
      process.stdout.write(`  Wrote ${output.outputName} (${formatFitLabel(output)})\n`)
    }
  } finally {
    runCommand('rm', ['-f', renderName, trimmedName, resizedName])
  }
}

function resolveRequestedAssets(argv) {
  if (argv.length === 0) return assets

  const requested = argv.map((value) => value.toLowerCase())
  const selected = assets.filter((asset) => {
    return requested.includes(asset.key)
      || requested.includes(path.basename(asset.sourcePath).toLowerCase())
  })

  if (selected.length === 0) {
    process.stderr.write(`Unknown asset selection: ${argv.join(', ')}\n`)
    process.exit(1)
  }

  return selected
}

function main() {
  ensureBinary('identify')
  ensureBinary('convert')

  const selectedAssets = resolveRequestedAssets(process.argv.slice(2))
  for (const asset of selectedAssets) {
    exportAsset(asset)
  }
}

main()