#!/usr/bin/env node
/**
 * Renders every PowerShell program this repo generates, so CI can parse them.
 *
 * The installer window and the tray are PowerShell scripts built inside
 * TypeScript template literals. Nothing in the normal build looks at them: tsc
 * sees a string, the linter sees a string, and a syntax error surfaces only as a
 * window that never appears on a user's machine — with the reason buried in a
 * diagnostic log nobody has yet been told to look for.
 *
 * The escaping is the sharper edge. A template literal eats a lone backslash, so
 * a PowerShell regex written `'\s+'` arrives as `'s+'`. That shipped once: it
 * would have replaced the letter "s" with a space in every message the installer
 * printed, and it was found by chance rather than by any check.
 *
 * Writes the scripts to `<outDir>` for the caller to parse. Rendering here (on
 * any OS) and parsing there (on Windows) keeps this script free of PowerShell.
 *
 * Usage: node scripts/ci/render-powershell.mjs <outDir>
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const outDir = process.argv[2]

/**
 * ESM import specifiers must be URLs, not paths.
 *
 * A bare absolute path works on Linux only because it looks like a URL path; on
 * Windows `D:\a\...` is read as the scheme `d:` and rejected outright
 * (ERR_UNSUPPORTED_ESM_URL_SCHEME). This script runs on windows-latest, which
 * is the only place that matters and the only place it would ever be noticed.
 */
const importFromRepo = (relative) => import(pathToFileURL(path.join(REPO_ROOT, relative)).href)
if (!outDir) {
  process.stderr.write('usage: render-powershell.mjs <outDir>\n')
  process.exit(1)
}

const { generateSetupGuiScript } = await importFromRepo('packages/sea-runtime/dist/setup-gui.js')
const { generateWindowsTrayScript } = await importFromRepo('packages/sea-runtime/dist/tray/windows-tray.js')
const { buildShortcutScript } = await importFromRepo('packages/sea-runtime/dist/tray/launcher.js')
const {
  buildInstallDirCleanupScript,
  buildUserSessionTrayScript,
  buildHideOwnConsoleScript
} = await importFromRepo('packages/sea-runtime/dist/windows-elevation.js')

/**
 * Inputs are only placeholders for the SHAPE of the script — the generators
 * interpolate them, so the values never change whether it parses. They do carry
 * a quote and a backslash on purpose, since those are what the escaping has to
 * survive.
 */
const AWKWARD = "C:\\Program Files\\PrintStream's Bridge\\app.exe"

const scripts = {
  'setup-gui.ps1': generateSetupGuiScript({
    progressFile: 'C:\\temp\\progress.json',
    logoPath: 'C:\\temp\\logo.png',
    iconPath: 'C:\\temp\\app.ico',
    readyFile: 'C:\\temp\\ready',
    appUserModelId: 'PrintStream.printstream-bridge',
    appName: "PrintStream's Bridge",
    title: 'Setting up PrintStream Bridge',
    showOpen: true,
    openLabel: 'Connect to workspace',
    showCopy: true,
    copyLabel: 'Copy code'
  }),
  'tray.ps1': generateWindowsTrayScript({
    iconPath: 'C:\\temp\\tray.ico',
    statusFile: 'C:\\temp\\status.json',
    logsDir: 'C:\\temp\\logs',
    appName: "PrintStream's Bridge",
    exePath: AWKWARD
  }),
  // These four are built inline as `[...].join('; ')`, which is how a `try` and
  // its `catch` ended up separated by a semicolon and rejected outright — found
  // by parsing, not by review.
  'install-dir-cleanup.ps1': buildInstallDirCleanupScript("C:\\Program Files\\PrintStream's Bridge", 'printstream-bridge'),
  'user-session-tray.ps1': buildUserSessionTrayScript(AWKWARD, 'tray run', "PrintStream's TrayLaunch"),
  'hide-own-console.ps1': buildHideOwnConsoleScript(),
  'start-menu-shortcut.ps1': buildShortcutScript(
    "C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\PrintStream's Bridge.lnk",
    'C:\\Windows\\System32\\wscript.exe',
    "C:\\Program Files\\PrintStream's Bridge\\tray-launch.vbs",
    "C:\\Program Files\\PrintStream's Bridge\\app.ico",
    "Show the PrintStream's Bridge tray icon"
  )
}

mkdirSync(outDir, { recursive: true })
for (const [name, contents] of Object.entries(scripts)) {
  const target = path.join(outDir, name)
  writeFileSync(target, contents, 'utf8')
  process.stdout.write(`rendered ${name} (${contents.length} chars)\n`)
}
