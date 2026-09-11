/**
 * Chooses a safe default for the subprocess-per-file test runner.
 *
 * CPU count alone is not a safe proxy inside WSL or a container with a memory cap. Each test child
 * can load tsx, jsdom, and a large application graph, so leave memory for dev servers and the host
 * before assigning the remainder to workers. An explicit runner flag or environment variable still
 * overrides this default when a dedicated CI machine can sustain more.
 */
import path from 'node:path'

const GIB = 1024 ** 3
const MAX_DEFAULT_CONCURRENCY = 4
const MEMORY_RESERVE_BYTES = 3 * GIB
const MEMORY_PER_WORKER_BYTES = 1.5 * GIB

export function defaultTestConcurrency({ cpuCount, availableMemoryBytes }) {
  const cpuBound = Math.max(1, Math.ceil(cpuCount / 2))
  const workerMemory = Math.max(0, availableMemoryBytes - MEMORY_RESERVE_BYTES)
  const memoryBound = Math.max(1, Math.floor(workerMemory / MEMORY_PER_WORKER_BYTES))
  return Math.min(cpuBound, memoryBound, MAX_DEFAULT_CONCURRENCY)
}

/** Splits one discovered test plan into bounded aggregate-runner lifetimes. */
export function batchTestFiles(files, batchSize) {
  const batches = []
  for (let start = 0; start < files.length; start += batchSize) {
    batches.push(files.slice(start, start + batchSize))
  }
  return batches
}

/**
 * Identifies every file that must be checked again after aggregate batches fail.
 *
 * Attribution is deliberately scoped to each failed batch. If one subprocess is killed before it
 * names a file, output from a different failed batch must not make that loss disappear: every file
 * in the unnamed batch remains a candidate for isolation.
 */
export function failedTestCandidates(failedBatches, workspaceRoot) {
  const candidates = []
  const unattributed = []

  for (const { files, output } of failedBatches) {
    const named = files.filter((file) => (
      output.includes(file) || output.includes(relativeTestPath(workspaceRoot, file))
    ))
    if (named.length > 0) {
      candidates.push(...named)
    } else {
      candidates.push(...files)
      unattributed.push(...files)
    }
  }

  return { candidates, unattributed }
}

function relativeTestPath(workspaceRoot, file) {
  return path.relative(workspaceRoot, file)
}
