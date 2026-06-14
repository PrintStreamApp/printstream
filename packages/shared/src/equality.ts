/**
 * Structural deep-equality used to suppress redundant work when a value is
 * re-derived but carries no new information (for example a printer status that
 * is byte-identical to the previous one). Handles plain objects, arrays, and
 * primitives; treats `NaN` as equal to `NaN`. Not intended for class instances,
 * Maps, Sets, or cyclic structures.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false

  const aIsArray = Array.isArray(a)
  const bIsArray = Array.isArray(b)
  if (aIsArray !== bIsArray) return false

  if (aIsArray && bIsArray) {
    if (a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqual(a[index], b[index])) return false
    }
    return true
  }

  const aRecord = a as Record<string, unknown>
  const bRecord = b as Record<string, unknown>
  const aKeys = Object.keys(aRecord)
  const bKeys = Object.keys(bRecord)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bRecord, key)) return false
    if (!deepEqual(aRecord[key], bRecord[key])) return false
  }
  return true
}
