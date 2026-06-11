/**
 * Electron tray host for the packaged bridge runtime.
 *
 * The desktop shell owns per-user storage paths, a small editable JSON config,
 * and the tray status/menu surface while reusing the existing bridge runtime.
 */
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { app, clipboard, Menu, Tray, nativeImage, shell } from 'electron'
import type { BridgeRuntimeStatusSnapshot } from '../runtime.js'
import { ensureBridgeDesktopConfig } from './config.js'

const APP_NAME = 'PrintStream Bridge'

const INITIAL_STATUS: BridgeRuntimeStatusSnapshot = {
  lifecycle: 'starting',
  bridgeId: null,
  connectCode: null,
  workspaceConnected: false,
  message: 'Preparing desktop bridge runtime.'
}

interface DesktopBridgePaths {
  rootDir: string
  stateFile: string
  libraryDir: string
}

let tray: Tray | null = null
let currentStatus: BridgeRuntimeStatusSnapshot = { ...INITIAL_STATUS }
let currentCloudUrl: string | null = null
let configFilePath: string | null = null
let bridgePaths: DesktopBridgePaths | null = null
let configCreatedOnLaunch = false

app.setName(APP_NAME)

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    tray?.popUpContextMenu()
  })
  void bootDesktopBridge()
}

async function bootDesktopBridge(): Promise<void> {
  await app.whenReady()

  if (process.platform === 'darwin') {
    app.dock?.hide()
  }

  bridgePaths = resolveDesktopBridgePaths(app.getPath('userData'))
  await mkdir(bridgePaths.rootDir, { recursive: true })
  await mkdir(bridgePaths.libraryDir, { recursive: true })

  tray = new Tray(createTrayImage(currentStatus.lifecycle))
  tray.on('click', () => tray?.popUpContextMenu())

  refreshTray()

  try {
    const configResult = await ensureBridgeDesktopConfig(bridgePaths.rootDir)
    currentCloudUrl = configResult.config.cloudUrl
    configFilePath = configResult.filePath
    configCreatedOnLaunch = configResult.created

    process.env.BRIDGE_CLOUD_URL ??= configResult.config.cloudUrl
    process.env.BRIDGE_LIBRARY_DIR ??= bridgePaths.libraryDir
    process.env.BRIDGE_NAME ??= configResult.config.bridgeName
    process.env.BRIDGE_STATE_FILE ??= bridgePaths.stateFile
    process.env.BRIDGE_VERSION ??= app.getVersion()

    refreshTray()

    const { BridgeRuntimeClient } = await import('../runtime.js')
    const runtime = new BridgeRuntimeClient({
      onStatusChange: (status) => {
        currentStatus = status
        refreshTray()
      }
    })
    currentStatus = runtime.getStatusSnapshot()
    refreshTray()

    void runtime.start().catch((error) => {
      currentStatus = {
        ...currentStatus,
        lifecycle: 'error',
        workspaceConnected: false,
        message: error instanceof Error ? error.message : 'Bridge runtime failed unexpectedly.'
      }
      refreshTray()
      console.error('Desktop bridge runtime exited unexpectedly', error)
    })
  } catch (error) {
    currentStatus = {
      ...currentStatus,
      lifecycle: 'error',
      workspaceConnected: false,
      message: error instanceof Error ? error.message : 'Failed to start the desktop bridge.'
    }
    refreshTray()
    console.error('Failed to start desktop bridge host', error)
  }
}

function resolveDesktopBridgePaths(userDataDir: string): DesktopBridgePaths {
  const rootDir = path.join(userDataDir, 'bridge-data')
  return {
    rootDir,
    stateFile: path.join(rootDir, 'bridge-state.json'),
    libraryDir: path.join(rootDir, 'library')
  }
}

function refreshTray(): void {
  if (!tray) {
    return
  }

  tray.setImage(createTrayImage(currentStatus.lifecycle))
  tray.setToolTip(buildTrayTooltip())
  if (process.platform === 'darwin') {
    tray.setTitle(compactStatusLabel(currentStatus))
  }
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()))
}

function buildTrayTooltip(): string {
  const lines = [APP_NAME, `Status: ${humanizeLifecycle(currentStatus.lifecycle)}`]
  if (currentStatus.bridgeId) {
    lines.push(`Bridge ID: ${currentStatus.bridgeId}`)
  }
  if (currentStatus.connectCode) {
    lines.push(`Connect code: ${currentStatus.connectCode}`)
  }
  if (currentStatus.message) {
    lines.push(currentStatus.message)
  }
  return lines.join('\n')
}

function buildTrayMenuTemplate(): Electron.MenuItemConstructorOptions[] {
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: APP_NAME, enabled: false },
    { label: `Status: ${humanizeLifecycle(currentStatus.lifecycle)}`, enabled: false },
    { label: `Cloud URL: ${currentCloudUrl ?? 'Not configured yet'}`, enabled: false },
    { label: `Bridge ID: ${currentStatus.bridgeId ?? 'Not assigned yet'}`, enabled: false },
    { label: `Connect code: ${currentStatus.connectCode ?? 'Waiting for pairing or already connected'}`, enabled: false }
  ]

  if (currentStatus.message) {
    template.push({ label: currentStatus.message, enabled: false })
  }

  if (configCreatedOnLaunch && configFilePath) {
    template.push({
      label: `Config created: ${path.basename(configFilePath)}. Edit it if this bridge should connect to a remote PrintStream API.`,
      enabled: false
    })
  }

  template.push(
    { type: 'separator' },
    {
      label: 'Copy Bridge ID',
      enabled: Boolean(currentStatus.bridgeId),
      click: () => {
        if (currentStatus.bridgeId) {
          clipboard.writeText(currentStatus.bridgeId)
        }
      }
    },
    {
      label: 'Copy Connect Code',
      enabled: Boolean(currentStatus.connectCode),
      click: () => {
        if (currentStatus.connectCode) {
          clipboard.writeText(currentStatus.connectCode)
        }
      }
    },
    {
      label: 'Open Config Folder',
      enabled: Boolean(configFilePath),
      click: () => {
        if (configFilePath) {
          shell.showItemInFolder(configFilePath)
        }
      }
    },
    {
      label: 'Open Bridge Library Folder',
      enabled: Boolean(bridgePaths),
      click: () => {
        if (bridgePaths) {
          void shell.openPath(bridgePaths.libraryDir)
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit()
      }
    }
  )

  return template
}

function compactStatusLabel(status: BridgeRuntimeStatusSnapshot): string {
  if (status.lifecycle === 'connected') {
    return 'Connected'
  }
  if (status.lifecycle === 'error') {
    return 'Error'
  }
  if (status.lifecycle === 'waiting-for-workspace' || status.lifecycle === 'pairing') {
    return status.connectCode ? `Code ${status.connectCode}` : 'Waiting'
  }
  return 'Bridge'
}

function humanizeLifecycle(lifecycle: BridgeRuntimeStatusSnapshot['lifecycle']): string {
  switch (lifecycle) {
    case 'starting':
      return 'Starting'
    case 'registering':
      return 'Registering'
    case 'pairing':
      return 'Pairing Ready'
    case 'connecting':
      return 'Connecting'
    case 'waiting-for-workspace':
      return 'Waiting For Workspace'
    case 'connected':
      return 'Connected'
    case 'disconnected':
      return 'Disconnected'
    case 'error':
      return 'Error'
  }
}

function createTrayImage(lifecycle: BridgeRuntimeStatusSnapshot['lifecycle']) {
  const color = trayColorForLifecycle(lifecycle)
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <rect x="4" y="4" width="24" height="24" rx="8" fill="#15232d" />
      <circle cx="16" cy="16" r="6" fill="${color}" />
      <path d="M16 10c3.3 0 6 2.7 6 6" stroke="#f7f9fb" stroke-width="2" stroke-linecap="round" fill="none" />
      <path d="M10 16c0-3.3 2.7-6 6-6" stroke="#f7f9fb" stroke-width="2" stroke-linecap="round" fill="none" />
    </svg>
  `.trim()
  return nativeImage
    .createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`)
    .resize({ width: 18, height: 18 })
}

function trayColorForLifecycle(lifecycle: BridgeRuntimeStatusSnapshot['lifecycle']): string {
  switch (lifecycle) {
    case 'connected':
      return '#34c759'
    case 'waiting-for-workspace':
    case 'pairing':
      return '#ff9f0a'
    case 'error':
      return '#ff453a'
    case 'disconnected':
      return '#8e8e93'
    default:
      return '#0a84ff'
  }
}