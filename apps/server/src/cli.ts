/**
 * CLI for the self-hosted PrintStream server executable. Parses a small command
 * set and dispatches to `setup` (guided install + browser open — the default on
 * a double-click), `run` (boot the stack in the foreground), `service`
 * (install/manage the OS service), `tray` (the notification-area icon),
 * `uninstall`, and `status` (read the status file). In-place update lands later.
 */
import { resolveServerPaths } from './app-identity.js'
import { isSeaPackaged } from './packaged.js'
import { runServer } from './run.js'
import {
  controlServerService,
  installServerService,
  uninstallServerService
} from './service.js'
import { runSetup } from './setup.js'
import { isStatusLive, readStatus } from './status.js'
import {
  installServerTrayAutostart,
  installedOrCurrentExePath,
  runServerTray,
  uninstallServerTrayAutostart
} from './tray.js'
import { runUninstall } from './uninstall.js'

const USAGE = `PrintStream (self-hosted) — single-executable server

Usage: printstream <command>

Commands:
  setup                        Install the background service, start the tray, and open
                               the app in your browser (the default on a double-click)
  run                          Start the app in the foreground (embedded database + web + API)
  service install [--port N]   Install and start the OS service (run elevated)
  service uninstall            Stop and remove the OS service (run elevated)
  service start|stop|restart   Control the installed service
  service status               Print the service status
  tray run                     Run the notification-area tray icon
  tray install|uninstall       Add/remove the login autostart entry for the tray
  uninstall [--purge]          Remove the service + tray (--purge also deletes all data)
  status                       Print whether the app is running (unelevated)
  help                         Show this help
`

export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv

  switch (command) {
    case undefined:
      // A bare launch (e.g. double-click) of the packaged app runs the guided
      // first-run; from source it just prints help.
      if (isSeaPackaged()) {
        await runSetup({ elevated: false })
        return 0
      }
      process.stdout.write(USAGE)
      return 0

    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(USAGE)
      return 0

    case 'setup':
      await runSetup({ elevated: rest.includes('--elevated') })
      return 0

    case 'run':
      await runServer()
      return 0

    case 'status':
      return printStatus()

    case 'service':
      return await runServiceCommand(rest)

    case 'tray':
      return await runTrayCommand(rest)

    case 'uninstall':
      await runUninstall({ purge: rest.includes('--purge'), elevated: rest.includes('--elevated') })
      return 0

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${USAGE}`)
      return 1
  }
}

function printStatus(): number {
  const status = readStatus(resolveServerPaths())
  if (!status || !isStatusLive(status)) {
    process.stdout.write('PrintStream is not running.\n')
    return 3
  }
  process.stdout.write(`PrintStream is running (pid ${status.pid}) on http://localhost:${status.port}\n`)
  return 0
}

async function runServiceCommand(args: string[]): Promise<number> {
  const [action, ...flags] = args
  switch (action) {
    case 'install': {
      const { exePath, configFile } = await installServerService({ port: readPortFlag(flags) })
      process.stdout.write(`Installed and started the PrintStream service.\n  Executable: ${exePath}\n  Config: ${configFile}\n`)
      return 0
    }
    case 'uninstall':
      await uninstallServerService()
      process.stdout.write('Removed the PrintStream service.\n')
      return 0
    case 'start':
    case 'stop':
    case 'restart':
      controlServerService(action)
      process.stdout.write(`Service ${action} requested.\n`)
      return 0
    case 'status':
      process.stdout.write(`${controlServerService('status') ?? 'unknown'}\n`)
      return 0
    default:
      process.stderr.write(`Unknown service action: ${action ?? '(none)'}\n\n${USAGE}`)
      return 1
  }
}

async function runTrayCommand(args: string[]): Promise<number> {
  const [action] = args
  switch (action) {
    case undefined:
    case 'run': {
      const result = await runServerTray()
      if (result.unsupported) {
        process.stderr.write("No tray support detected on this desktop. Run 'printstream status' instead.\n")
        return 1
      }
      return result.exitCode
    }
    case 'install': {
      const entry = await installServerTrayAutostart(installedOrCurrentExePath())
      process.stdout.write(`Tray autostart installed (${entry}). It starts at your next login; run 'printstream tray run' to start it now.\n`)
      return 0
    }
    case 'uninstall':
      await uninstallServerTrayAutostart()
      process.stdout.write('Tray autostart removed.\n')
      return 0
    default:
      process.stderr.write(`Unknown tray action: ${action}\n\n${USAGE}`)
      return 1
  }
}

function readPortFlag(flags: string[]): number | undefined {
  const index = flags.indexOf('--port')
  if (index === -1) return undefined
  const value = Number(flags[index + 1])
  return Number.isInteger(value) && value > 0 ? value : undefined
}
