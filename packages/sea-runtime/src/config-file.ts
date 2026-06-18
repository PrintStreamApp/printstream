/**
 * Reads and rewrites the standalone install's `bridge.env` config file. The
 * file is plain dotenv so operators can edit it by hand; updates here preserve
 * unrelated lines and comments.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export async function readConfigFileValues(configFile: string): Promise<Record<string, string>> {
  const raw = await readFile(configFile, 'utf8').catch(() => null)
  if (raw === null) return {}
  return parseConfigLines(raw)
}

export function parseConfigLines(raw: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line)
    if (!match || !match[1]) continue
    values[match[1]] = unquote(match[2] ?? '')
  }
  return values
}

/**
 * Merges values into the config file, replacing existing assignments in place
 * and appending new keys. `undefined` values are skipped; `null` removes the
 * assignment.
 */
export async function writeConfigFileValues(
  configFile: string,
  values: Record<string, string | null | undefined>
): Promise<void> {
  const raw = await readFile(configFile, 'utf8').catch(() => null)
  const lines = raw === null ? [] : raw.split(/\r?\n/)
  const pending = new Map(Object.entries(values).filter(([, value]) => value !== undefined))

  const nextLines: string[] = []
  for (const line of lines) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)
    const key = match?.[1]
    if (key && pending.has(key)) {
      const value = pending.get(key)
      pending.delete(key)
      if (value === null || value === undefined) continue
      nextLines.push(formatAssignment(key, value))
      continue
    }
    nextLines.push(line)
  }
  while (nextLines.length > 0 && nextLines[nextLines.length - 1] === '') {
    nextLines.pop()
  }
  for (const [key, value] of pending) {
    if (value === null || value === undefined) continue
    nextLines.push(formatAssignment(key, value))
  }

  await mkdir(path.dirname(configFile), { recursive: true })
  await writeFile(configFile, nextLines.join('\n') + '\n', 'utf8')
}

function formatAssignment(key: string, value: string): string {
  return /[\s#'"\\]/.test(value) ? `${key}=${JSON.stringify(value)}` : `${key}=${value}`
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    const inner = trimmed.slice(1, -1)
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(trimmed) as string
      } catch {
        return inner
      }
    }
    return inner
  }
  const hashIndex = trimmed.indexOf(' #')
  return hashIndex >= 0 ? trimmed.slice(0, hashIndex).trim() : trimmed
}
