/**
 * Desktop bridge configuration stored in the packaged app's user-data folder.
 *
 * The tray app owns user-local paths so packaged installs do not depend on the
 * Docker-oriented bridge defaults used by the headless runtime.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

const DEFAULT_BRIDGE_DESKTOP_CONFIG = {
  cloudUrl: 'http://localhost:4000',
  bridgeName: 'PrintStream Bridge'
} as const

const bridgeDesktopConfigSchema = z.object({
  cloudUrl: z.string().url(),
  bridgeName: z.string().trim().min(1).max(120)
})

const bridgeDesktopConfigInputSchema = bridgeDesktopConfigSchema.partial()

export type BridgeDesktopConfig = z.infer<typeof bridgeDesktopConfigSchema>

export interface BridgeDesktopConfigResult {
  config: BridgeDesktopConfig
  filePath: string
  created: boolean
}

export function getDefaultBridgeDesktopConfig(): BridgeDesktopConfig {
  return { ...DEFAULT_BRIDGE_DESKTOP_CONFIG }
}

export async function ensureBridgeDesktopConfig(configDir: string): Promise<BridgeDesktopConfigResult> {
  await mkdir(configDir, { recursive: true })
  const filePath = path.join(configDir, 'bridge-desktop.json')

  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = bridgeDesktopConfigInputSchema.parse(JSON.parse(raw))
    const config = bridgeDesktopConfigSchema.parse({
      ...DEFAULT_BRIDGE_DESKTOP_CONFIG,
      ...parsed
    })
    const normalized = JSON.stringify(config, null, 2) + '\n'
    if (raw !== normalized) {
      await writeFile(filePath, normalized, 'utf8')
    }
    return { config, filePath, created: false }
  } catch (error) {
    const isMissing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
    if (!isMissing) {
      throw new Error(`Desktop bridge config at ${filePath} is invalid.`, { cause: error })
    }
  }

  const config = getDefaultBridgeDesktopConfig()
  await writeFile(filePath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  return { config, filePath, created: true }
}