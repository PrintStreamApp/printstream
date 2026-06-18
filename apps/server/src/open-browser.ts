/**
 * Best-effort "open this URL in the user's browser", used by the guided first
 * run. Spawns the platform opener detached and never throws — on a headless box
 * (no desktop) it simply does nothing.
 */
import { spawn } from 'node:child_process'

export function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    // windowsHide: the packaged exe is GUI-subsystem, so spawning `cmd` without
    // it would flash a console window before `start` hands off to the browser.
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    // A missing opener (e.g. no `xdg-open` on a headless box) emits an async
    // 'error' event; without a listener that throws and would crash the server.
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // No desktop / opener available — the URL is printed to the console anyway.
  }
}
