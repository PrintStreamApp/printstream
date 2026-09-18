/** Distinct, deterministic defaults for one entity catalog; explicit user colors always win. */
import { colorDistance } from './colorDistance'

/** Choose the unused candidate whose nearest existing color is perceptually farthest away. */
export function suggestTagColor(existingColors: readonly string[]): string {
  const used = new Set(existingColors.map((color) => color.toLowerCase()))
  let best = '#38bdf8'
  let bestDistance = -1
  const candidates = [best]
  // Midrange RGB samples avoid nearly black/white dots that disappear into either theme.
  for (let red = 48; red <= 240; red += 32) {
    for (let green = 48; green <= 240; green += 32) {
      for (let blue = 48; blue <= 240; blue += 32) {
        candidates.push(`#${[red, green, blue].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`)
      }
    }
  }
  for (const candidate of candidates) {
    if (used.has(candidate)) continue
    const distance = Math.min(...existingColors.map((color) => colorDistance(candidate, color)))
    if (distance > bestDistance) {
      best = candidate
      bestDistance = distance
    }
  }
  if (bestDistance >= 0) return best

  // A catalog can exhaust the candidate grid. Preserve uniqueness even then; perceptual
  // separation necessarily falls as the catalog grows. The UI still permits manual overrides.
  for (let rgb = 0; rgb <= 0xffffff; rgb++) {
    const candidate = `#${rgb.toString(16).padStart(6, '0')}`
    if (!used.has(candidate)) return candidate
  }
  return best
}
