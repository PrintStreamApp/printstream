/**
 * Owns slicer CLI argument-template expansion and where the POSITIONAL input path sits, including where
 * generated arguments (profile `--load-*` flags, `--skip-objects`, `--filament-map`) may be
 * spliced in.
 *
 * The contract callers rely on: the positional input is the LAST occurrence of the input path in
 * the arg list, and everything generated goes immediately before it. That matters because the
 * args template can mention `{input}` more than once: the default template ends
 * `... --export-json {input} {input}`, where the first occurrence is `--export-json`'s VALUE and
 * only the second is the positional. Splicing before the first occurrence would land the
 * generated args between `--export-json` and its filename, silently corrupting both. Today that
 * stays latent only because `--export-json` is absent from BambuStudio 2.7.x's `--help` and is
 * stripped as unsupported, leaving a single occurrence; an engine that supports the flag would
 * hit it immediately.
 */
import path from 'node:path'
import { env } from './env.js'
import { buildFilamentMapArgs } from './filament-map-args.js'
import type { RuntimeSlicerTarget } from './slicer-targets.js'

/** Append the positional input when the args template never mentioned it. */
export function ensurePositionalInputArgument(args: string[], inputPath: string): string[] {
  return args.includes(inputPath) ? args : [...args, inputPath]
}

/**
 * Splice generated arguments immediately before the positional input (the last occurrence of
 * `inputPath`), so they can never be mistaken for a preceding flag's value. Falls back to
 * appending when the input is absent: callers normally run {@link ensurePositionalInputArgument}
 * first, which makes that unreachable.
 */
export function insertArgsBeforePositionalInput(args: string[], inputPath: string, extraArgs: string[]): string[] {
  if (extraArgs.length === 0) return args
  const positionalIndex = args.lastIndexOf(inputPath)
  if (positionalIndex < 0) return [...args, ...extraArgs]
  return [...args.slice(0, positionalIndex), ...extraArgs, ...args.slice(positionalIndex)]
}

/** Remove a flag and its value only when the selected engine lacks that flag. */
export function stripUnsupportedFlagArguments(args: string[], supportedFlags: ReadonlySet<string>, flagNames: string[]): string[] {
  const unsupportedFlags = new Set(flagNames.map((entry) => entry.toLowerCase()).filter((entry) => !supportedFlags.has(entry)))
  if (unsupportedFlags.size === 0) return args

  const filtered: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (typeof value !== 'string') continue
    if (unsupportedFlags.has(value.toLowerCase())) {
      index += 1
      continue
    }
    filtered.push(value)
  }
  return filtered
}

function stripFlagArguments(args: string[], flagNames: string[]): string[] {
  const removableFlags = new Set(flagNames.map((entry) => entry.toLowerCase()))
  if (removableFlags.size === 0) return args

  const filtered: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]
    if (typeof value !== 'string') continue
    if (removableFlags.has(value.toLowerCase())) {
      index += 1
      continue
    }
    filtered.push(value)
  }
  return filtered
}

function stripStandaloneFlags(args: string[], flagNames: string[]): string[] {
  const removableFlags = new Set(flagNames.map((entry) => entry.toLowerCase()))
  if (removableFlags.size === 0) return args
  return args.filter((value) => !removableFlags.has(value.toLowerCase()))
}

/** Expand the selected target's template and insert generated args before its positional input. */
export function buildCliArgs(input: {
  slicerTarget: RuntimeSlicerTarget
  inputPath: string
  outputPath: string
  outputFileName: string
  plate: number
  supportedFlags: ReadonlySet<string>
  profileArgs: string[]
  /** Manual dual-nozzle assignment to pin on the CLI; null when nozzle mode stays automatic. */
  manualFilamentMap: string[] | null
  removedFlags: string[]
  removedStandaloneFlags: string[]
  bambuHomeDir: string
  bambuConfigDir: string
  bambuCacheDir: string
  bambuDataDir: string
}): string[] {
  const expandedArgs = splitArgsTemplate(input.slicerTarget.cliArgsTemplate ?? env.SLICER_CLI_ARGS_TEMPLATE ?? '')
    .map((value) => value
      .replaceAll('{input}', input.inputPath)
      .replaceAll('{output}', input.outputPath)
      .replaceAll('{outputDir}', path.dirname(input.outputPath))
      .replaceAll('{outputFileName}', input.outputFileName)
      .replaceAll('{plate}', String(input.plate))
      .replaceAll('{plateZeroBased}', String(Math.max(0, input.plate - 1)))
      .replaceAll('{homeDir}', input.bambuHomeDir)
      .replaceAll('{configDir}', input.bambuConfigDir)
      .replaceAll('{cacheDir}', input.bambuCacheDir)
      .replaceAll('{dataDir}', input.bambuDataDir))

  const supportedArgs = stripUnsupportedFlagArguments(expandedArgs, input.supportedFlags, ['--export-json'])
  const withoutStandaloneFlags = stripStandaloneFlags(supportedArgs, input.removedStandaloneFlags)
  const withoutRemovedFlags = stripFlagArguments(withoutStandaloneFlags, input.removedFlags)
  const templateArgs = ensurePositionalInputArgument(withoutRemovedFlags, input.inputPath)

  return insertArgsBeforePositionalInput(templateArgs, input.inputPath, [
    ...input.profileArgs,
    ...buildFilamentMapArgs(input.manualFilamentMap)
  ])
}

/** Split a simple quoted argument template without invoking a shell. */
export function splitArgsTemplate(value: string): string[] {
  const matches = value.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
  return matches.map((entry) => entry.replace(/^['"]|['"]$/g, ''))
}
