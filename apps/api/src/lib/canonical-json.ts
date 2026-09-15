/**
 * Deterministic JSON serialization for hashes that bind persisted behavior.
 *
 * Object keys are sorted and undefined members are omitted, matching normal JSON semantics while
 * making equivalent records independent of construction order. Array order remains significant.
 */

/** Serialize a JSON-compatible value with recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}
