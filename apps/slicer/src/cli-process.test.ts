import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { SlicingOutputLine } from '@printstream/shared'
import { executeCli } from './cli-process.js'
import type { RuntimeSlicerTarget } from './slicer-targets.js'

/** Run a small Node child through the same process boundary used for native engines. */
async function runFakeCli(script: string, signal?: AbortSignal): Promise<SlicingOutputLine[]> {
  const jobTempDir = await mkdtemp(path.join(os.tmpdir(), 'printstream-cli-process-'))
  const outputLines: SlicingOutputLine[] = []
  const slicerTarget = {
    id: 'fake',
    cliPath: process.execPath,
    cliArgsPrefix: ['-e', script]
  } as RuntimeSlicerTarget
  try {
    await executeCli({
      slicerTarget,
      args: [],
      outputPath: path.join(jobTempDir, 'output.gcode'),
      outputLines,
      supportedFlags: new Set(),
      bambuHomeDir: jobTempDir,
      bambuConfigDir: jobTempDir,
      bambuCacheDir: jobTempDir,
      bambuDataDir: jobTempDir,
      jobKey: 'cli-process-test',
      jobTempDir,
      maxOutputBytes: 1024 * 1024,
      signal
    })
    return outputLines
  } finally {
    await rm(jobTempDir, { recursive: true, force: true })
  }
}

test('CLI process captures output and accepts a completed child', async () => {
  const output = await runFakeCli('console.log("finished output")')
  assert.ok(output.some((line) => line.text.includes('finished output')))
})

test('CLI process reports a failed child through the existing classifier', async () => {
  await assert.rejects(runFakeCli('console.error("intentional CLI failure"); process.exit(7)'), /intentional CLI failure|code 7|exited/i)
})

test('CLI process refuses an already cancelled slice', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(runFakeCli('setInterval(() => {}, 1000)', controller.signal), /Slicing cancelled/)
})
