/**
 * Tray icon assets embedded as base64 so they survive both tsc and the SEA
 * bundle without asset plumbing: a 32x32 PNG for Linux trays and a multi-size
 * ICO (ASSET-5's fifteen frames) for the Windows NotifyIcon, the Add/Remove
 * Programs entry, the standalone executables and the desktop app. Both are
 * rendered from the brand master (`assets/brand/icon.svg`) by
 * `scripts/generate-tray-icons.mjs`, which explains the ICO's format.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { TRAY_ICON_ICO_BASE64, TRAY_ICON_PNG_BASE64 } from './icon-data.generated.js'

export function trayIconPngBuffer(): Buffer {
  return Buffer.from(TRAY_ICON_PNG_BASE64, 'base64')
}

export function trayIconIcoBuffer(): Buffer {
  return Buffer.from(TRAY_ICON_ICO_BASE64, 'base64')
}

export interface TrayIconFiles {
  pngPath: string
  icoPath: string
}

export async function writeTrayIconFiles(directory: string): Promise<TrayIconFiles> {
  await mkdir(directory, { recursive: true })
  const pngPath = path.join(directory, 'printstream-bridge-tray.png')
  const icoPath = path.join(directory, 'printstream-bridge-tray.ico')
  await writeFile(pngPath, trayIconPngBuffer())
  await writeFile(icoPath, trayIconIcoBuffer())
  return { pngPath, icoPath }
}
