/**
 * The prepare-time read has to work on BOTH output shapes and stay cheap on the packaged one.
 *
 * A sliced plate is routinely hundreds of megabytes decompressed, and this runs on every successful
 * slice, so "read the whole entry and take the first 16KB" would be a real cost paid for a two-line
 * header. The large-entry case below is the one that catches that: it also pins the stream teardown,
 * which settles on `close` rather than `end` and would otherwise hang the promise forever.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import yazl from 'yazl'
import { readGcodeHeader, readPrepareTimeSeconds, readSlicedOutputTiming } from './gcode-header.js'

/** Verbatim from a BambuStudio 2.8.2.61 slice: prepare = 4h 56m 29s - 4h 51m 5s = 324s. */
const REAL_HEADER = [
  '; HEADER_BLOCK_START',
  '; BambuStudio 02.08.02.61',
  '; model printing time: 4h 51m 5s; total estimated time: 4h 56m 29s',
  '; total layer number: 163',
  '; HEADER_BLOCK_END',
  ''
].join('\n')

/**
 * A temp tree removed when the test finishes. Not optional hygiene: the large-entry case below
 * writes ~2.8MB per run, and `npm run validate` is the repo's inner loop, so leaking these fills a
 * container's tmpfs until unrelated writes start failing. `save-retarget.test.ts` cleans up the same
 * way.
 */
async function workDir(t: { after: (fn: () => void | Promise<void>) => void }): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'gcode-header-'))
  t.after(async () => { await rm(dir, { recursive: true, force: true }) })
  return dir
}

/** A `.gcode.3mf`: the shape the CLI produces unless a plain `.gcode` was requested. */
async function writePackaged(filePath: string, gcode: string): Promise<void> {
  const zip = new yazl.ZipFile()
  // A non-gcode entry first, so the reader is forced to skip rather than take entry zero.
  zip.addBuffer(Buffer.from('<?xml version="1.0"?><model/>'), '3D/3dmodel.model')
  zip.addBuffer(Buffer.from(gcode, 'utf8'), 'Metadata/plate_1.gcode')
  zip.end()
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(filePath)
    out.on('close', () => resolve())
    out.on('error', reject)
    zip.outputStream.pipe(out)
  })
}

test('reads the prepare phase from a plain .gcode output', async (t) => {
  const dir = await workDir(t)
  const file = path.join(dir, 'plate.gcode')
  await writeFile(file, REAL_HEADER + 'G1 X1 Y1\n')
  assert.equal(await readPrepareTimeSeconds(file), 324)
})

test('reads the prepare phase from inside a packaged .gcode.3mf', async (t) => {
  const dir = await workDir(t)
  const file = path.join(dir, 'plate.gcode.3mf')
  await writePackaged(file, REAL_HEADER + 'G1 X1 Y1\n')
  assert.equal(await readPrepareTimeSeconds(file), 324)
})

test('a huge packaged entry is answered from its head, not read to the end', async (t) => {
  const dir = await workDir(t)
  const file = path.join(dir, 'big.gcode.3mf')
  // Well past the 16KB probe. If the reader waited for 'end' on a destroyed stream, or buffered the
  // whole entry, this is where it would hang or balloon.
  await writePackaged(file, REAL_HEADER + 'G1 X1 Y1 E0.1\n'.repeat(200_000))
  const started = process.hrtime.bigint()
  assert.equal(await readPrepareTimeSeconds(file), 324)
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(elapsedMs < 5_000, `expected a head-only read, took ${Math.round(elapsedMs)}ms`)
})

test('an all-plate export sums the prepare phase across every plate', async (t) => {
  // Scope has to match its sibling: `estimatedPrintTimeSeconds` adds `total_predication` over every
  // sliced plate, so reporting plate 1's prepare beside four plates' print time would put two
  // different scopes on one panel. Four plates really are heated and levelled four times.
  const dir = await workDir(t)
  const file = path.join(dir, 'all-plates.gcode.3mf')
  const zip = new yazl.ZipFile()
  zip.addBuffer(Buffer.from('<?xml version="1.0"?><model/>'), '3D/3dmodel.model')
  for (const plate of [1, 2, 3]) {
    zip.addBuffer(Buffer.from(REAL_HEADER + 'G1 X1 Y1\n', 'utf8'), `Metadata/plate_${plate}.gcode`)
  }
  zip.end()
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file)
    out.on('close', () => resolve())
    out.on('error', reject)
    zip.outputStream.pipe(out)
  })
  assert.equal(await readPrepareTimeSeconds(file), 324 * 3)
})

test('an all-plate export reports distinct plate times from its G-code headers', async (t) => {
  const dir = await workDir(t)
  const file = path.join(dir, 'distinct-plates.gcode.3mf')
  const zip = new yazl.ZipFile()
  zip.addBuffer(Buffer.from('; model printing time: 2h 50m; total estimated time: 3h\n'), 'Metadata/plate_1.gcode')
  zip.addBuffer(Buffer.from('; model printing time: 4h 50m; total estimated time: 5h\n'), 'Metadata/plate_2.gcode')
  zip.end()
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file)
    out.on('close', resolve)
    out.on('error', reject)
    zip.outputStream.pipe(out)
  })

  assert.deepEqual(await readSlicedOutputTiming(file), {
    totalSeconds: 8 * 3600,
    prepareSeconds: 20 * 60,
    plates: [
      { index: 1, totalSeconds: 3 * 3600 },
      { index: 2, totalSeconds: 5 * 3600 }
    ]
  })
})

test('an output with no time line reports nothing rather than zero', async (t) => {
  const dir = await workDir(t)
  const file = path.join(dir, 'plain.gcode')
  await writeFile(file, '; HEADER_BLOCK_START\n; total layer number: 4\nG1 X1\n')
  assert.equal(await readPrepareTimeSeconds(file), null)
})

test('a missing or empty output is answered, not thrown', async (t) => {
  // Best effort by contract: a slice that produced a printable file must never fail over a usage
  // estimate, so every unreadable case has to come back as null.
  const dir = await workDir(t)
  assert.equal(await readPrepareTimeSeconds(path.join(dir, 'nope.gcode')), null)
  const empty = path.join(dir, 'empty.gcode')
  await writeFile(empty, '')
  assert.equal(await readPrepareTimeSeconds(empty), null)
  assert.equal(await readGcodeHeader(path.join(dir, 'nope.gcode')), null)
})

test('a packaged output carrying no gcode entry is answered, not thrown', async (t) => {
  const dir = await workDir(t)
  const file = path.join(dir, 'no-gcode.3mf')
  const zip = new yazl.ZipFile()
  zip.addBuffer(Buffer.from('<?xml version="1.0"?><model/>'), '3D/3dmodel.model')
  zip.end()
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(file)
    out.on('close', () => resolve())
    out.on('error', reject)
    zip.outputStream.pipe(out)
  })
  assert.equal(await readPrepareTimeSeconds(file), null)
})
