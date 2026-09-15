/**
 * Task-local materialization for custom build-plate assets embedded in a machine preset.
 *
 * The preset remains portable at rest. Only the resolved config handed to the engine receives
 * absolute filesystem paths, and the PrintStream-only payload fields never reach the engine.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  portableMachineBedAssetBytes,
  stripPortableMachineBedAssetPayloads,
  type ProcessConfig
} from '@printstream/shared'

/** Write embedded bed assets into `outputDir` and return the engine-facing machine config. */
export async function materializePortableBedAssets(
  config: ProcessConfig,
  outputDir: string
): Promise<ProcessConfig> {
  const next = stripPortableMachineBedAssetPayloads(config)
  for (const kind of ['model', 'texture'] as const) {
    const asset = portableMachineBedAssetBytes(config, kind)
    if (!asset) continue
    const extension = path.extname(asset.name).toLowerCase()
    const assetDir = path.join(outputDir, 'bed-assets')
    const assetPath = path.join(assetDir, `custom-bed-${kind}${extension}`)
    await mkdir(assetDir, { recursive: true })
    await writeFile(assetPath, asset.bytes)
    next[kind === 'model' ? 'bed_custom_model' : 'bed_custom_texture'] = assetPath
  }
  return next
}
