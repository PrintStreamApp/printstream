/**
 * Shared hidden Windows launch formatting for tray entries and uninstall
 * handoffs. Owns Win32 argv quoting, then VBScript string escaping, rather than
 * allowing spaces or quotes to become a second command. It never runs a shell.
 */
import path from 'node:path'

/** Quote one CreateProcess argument, preserving embedded quotes and trailing backslashes. */
function quoteWindowsArgument(value: string, alwaysQuote = false): string {
  if (!alwaysQuote && value && !/[\s"]/.test(value)) return value
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`
}

/**
 * Return a VBScript string literal containing an executable and its exact argv.
 * The executable stays quoted to preserve existing tray launcher contents.
 * Refuses NUL/newlines and the native command-line limit before any launch.
 */
export function windowsVbsCommandLiteral(executable: string, args: readonly string[]): string {
  const values = [executable, ...args]
  if (values.some(value => /[\0\r\n]/.test(value))) {
    throw new Error('Windows hidden launch refuses control characters')
  }
  const command = [quoteWindowsArgument(executable, true), ...args.map(value => quoteWindowsArgument(value))].join(' ')
  if (command.length + 1 > 32767) throw new Error('Windows hidden launch command line exceeds the native limit')
  return `"${command.replaceAll('"', '""')}"`
}

/** Absolute Windows Script Host path, shared with existing tray launchers. */
export function windowsWscriptPath(): string {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'wscript.exe')
}

/** Absolute built-in PowerShell path; executable lookup never uses the current directory. */
export function windowsPowerShellPath(): string {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}
