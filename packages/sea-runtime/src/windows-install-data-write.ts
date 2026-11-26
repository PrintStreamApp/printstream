/**
 * Native startup normally writes DATA outside the installation. An accepted
 * custom DATA location overlapping installed files instead shares installation
 * admission, so a new runtime cannot recreate files under a delayed uninstall.
 * The lease covers bootstrap only; normal live writers remain owned by runtime
 * retirement, which destructive uninstall must establish before file removal.
 */
import { realpathSync } from 'node:fs'
import path from 'node:path'
import { withWindowsInstallOperation } from './windows-install-operation.js'

/** Resolve existing ancestors physically, retaining not-yet-created leaf names. */
function physicalWindowsPath(value: string): string {
  let cursor = path.win32.resolve(value)
  const suffix: string[] = []
  for (;;) {
    try { return path.win32.join(realpathSync.native(cursor), ...suffix) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = path.win32.dirname(cursor)
      if (parent === cursor) throw error
      suffix.unshift(path.win32.basename(cursor))
      cursor = parent
    }
  }
}

/**
 * Claim only when DATA physically overlaps the installed directory. Ordinary
 * portable runs with separate DATA keep their existing unelevated behavior.
 * Short-name aliases resolve before the containment decision; errors refuse.
 */
export function withWindowsInstallDataWrite<T>(installedExePath: string, dataDir: string, callback: () => T): T {
  if (process.platform !== 'win32') return callback()
  const install = physicalWindowsPath(path.win32.dirname(installedExePath))
  const data = physicalWindowsPath(dataDir)
  const relative = path.win32.relative(install, data)
  const inverse = path.win32.relative(data, install)
  const contains = (value: string): boolean => value !== '..' && !value.startsWith('..\\') && !path.win32.isAbsolute(value)
  if (!contains(relative) && !contains(inverse)) return callback()
  return withWindowsInstallOperation(installedExePath, callback, dataDir)
}
