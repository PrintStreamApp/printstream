/**
 * Lossless decimal mesh-coordinate serialization for 3MF writers. Source units may be tiny
 * and magnified by an instance transform, so rounding to a fixed number of decimal places
 * can collapse real features. Keep Number's round-trip digits and expand exponent notation
 * into plain decimals for 3MF consumers. Inputs are finite, validated mesh coordinates.
 */
export function formatMeshCoordinate(value: number): string {
  const text = String(value)
  const [coefficient, exponentText] = text.split('e')
  if (exponentText === undefined) return text
  const negative = coefficient!.startsWith('-')
  const [integer, fraction = ''] = (negative ? coefficient!.slice(1) : coefficient!).split('.')
  const digits = integer! + fraction
  const point = integer!.length + Number(exponentText)
  const decimal = point <= 0
    ? `0.${'0'.repeat(-point)}${digits}`
    : point >= digits.length
      ? digits + '0'.repeat(point - digits.length)
      : `${digits.slice(0, point)}.${digits.slice(point)}`
  return negative ? `-${decimal}` : decimal
}
