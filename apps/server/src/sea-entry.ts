/**
 * Process entry point for the self-hosted PrintStream server executable. Kept
 * minimal: parse the CLI and exit with its status code. The SEA build (Phase 5)
 * bundles this entry together with `@printstream/api`, the web bundle, the Prisma
 * query engine, the embedded Postgres binaries, and ffmpeg.
 */
import { runCli } from './cli.js'

void runCli(process.argv.slice(2))
  .then((code) => {
    // `run` never resolves (the server keeps the loop alive); other commands do.
    if (code !== 0) process.exitCode = code
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
