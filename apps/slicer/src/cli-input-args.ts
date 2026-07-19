/**
 * Owns where the POSITIONAL input path sits in a slicer CLI argument list, and therefore where
 * generated arguments (profile `--load-*` flags, `--skip-objects`, `--filament-map`) may be
 * spliced in.
 *
 * The contract callers rely on: the positional input is the LAST occurrence of the input path in
 * the arg list, and everything generated goes immediately before it. That matters because the
 * args template can mention `{input}` more than once — the default template ends
 * `… --export-json {input} {input}`, where the first occurrence is `--export-json`'s VALUE and
 * only the second is the positional. Splicing before the first occurrence would land the
 * generated args between `--export-json` and its filename, silently corrupting both. Today that
 * stays latent only because `--export-json` is absent from BambuStudio 2.7.x's `--help` and is
 * stripped as unsupported, leaving a single occurrence; an engine that supports the flag would
 * hit it immediately.
 */

/** Append the positional input when the args template never mentioned it. */
export function ensurePositionalInputArgument(args: string[], inputPath: string): string[] {
  return args.includes(inputPath) ? args : [...args, inputPath]
}

/**
 * Splice generated arguments immediately before the positional input (the last occurrence of
 * `inputPath`), so they can never be mistaken for a preceding flag's value. Falls back to
 * appending when the input is absent — callers normally run {@link ensurePositionalInputArgument}
 * first, which makes that unreachable.
 */
export function insertArgsBeforePositionalInput(args: string[], inputPath: string, extraArgs: string[]): string[] {
  if (extraArgs.length === 0) return args
  const positionalIndex = args.lastIndexOf(inputPath)
  if (positionalIndex < 0) return [...args, ...extraArgs]
  return [...args.slice(0, positionalIndex), ...extraArgs, ...args.slice(positionalIndex)]
}
