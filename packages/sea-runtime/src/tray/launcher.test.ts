import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ensureWindowsLaunchVbs, ensureWindowsTrayVbs } from './launcher.js'

/**
 * `ensureWindowsTrayVbs` builds its path with `path.win32`, so on a POSIX test
 * runner it returns a backslash-joined RELATIVE name and writes it into the
 * current directory. Every test therefore runs from a scratch directory and
 * restores the old one, without this the suite drops literal `\Program
 * Files\...` files into the repository (which it did, once).
 */
function inScratchDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'tray-launcher-'))
  const previous = process.cwd()
  process.chdir(dir)
  try {
    body(dir)
  } finally {
    process.chdir(previous)
  }
}

const WINDOWS_EXE = 'C:\\Program Files\\PrintStream Bridge\\printstream-bridge.exe'

test('writes the launcher once and leaves it alone afterwards', () => {
  inScratchDir(() => {
    const vbsPath = ensureWindowsTrayVbs(WINDOWS_EXE)
    assert.match(readFileSync(vbsPath, 'utf8'), /tray run/)
    const first = statSync(vbsPath).mtimeMs

    // The reported bug: setup calls this three times, and one of those calls
    // runs wscript against the file. Rewriting identical content is what raced
    // the reader into ERROR_SHARING_VIOLATION, so an unchanged file must not be
    // touched at all.
    assert.equal(ensureWindowsTrayVbs(WINDOWS_EXE), vbsPath)
    assert.equal(statSync(vbsPath).mtimeMs, first, 'unchanged content must not rewrite the file')
  })
})

test('rewrites when the target executable changed', () => {
  inScratchDir(() => {
    const vbsPath = ensureWindowsTrayVbs(WINDOWS_EXE)
    writeFileSync(vbsPath, 'CreateObject("WScript.Shell").Run """C:\\old\\bridge.exe"" tray run", 0, False\r\n')

    ensureWindowsTrayVbs(WINDOWS_EXE)
    const contents = readFileSync(vbsPath, 'utf8')
    assert.match(contents, /printstream-bridge\.exe/)
    assert.doesNotMatch(contents, /old/)
  })
})

test('leaves no temp file behind', () => {
  inScratchDir((dir) => {
    ensureWindowsTrayVbs(WINDOWS_EXE)
    assert.deepEqual(readdirSync(dir).filter((name) => name.endsWith('.tmp')), [])
  })
})

test('each launcher entry gets its own script, so two shortcuts run two verbs', () => {
  inScratchDir(() => {
    const trayVbs = ensureWindowsTrayVbs(WINDOWS_EXE)
    const openVbs = ensureWindowsLaunchVbs(WINDOWS_EXE, ['open'], 'open-launch.vbs')

    assert.notEqual(trayVbs, openVbs)
    assert.match(readFileSync(trayVbs, 'utf8'), /" tray run"/)
    assert.match(readFileSync(openVbs, 'utf8'), /" open"/)
    // The exe path stays quoted inside the VBScript string literal; losing that
    // breaks every install under "C:\\Program Files".
    assert.ok(readFileSync(openVbs, 'utf8').startsWith(`CreateObject("WScript.Shell").Run """${WINDOWS_EXE}"" open"`))
  })
})
