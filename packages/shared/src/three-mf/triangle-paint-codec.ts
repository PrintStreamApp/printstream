/**
 * Bambu/PrusaSlicer TriangleSelector paint-tree CODEC — the string half of triangle painting.
 *
 * A painted triangle's 3MF attribute (`paint_supports`/`paint_seam`/`paint_color`) is a hex string
 * encoding a recursive split tree (TriangleSelector::serialize):
 * - The bitstream is read 4 bits per hex digit, LSB-first, digits consumed from the END of the
 *   string (FacetsAnnotation builds the string reversed).
 * - Each node: 2 bits split-side count. Leaves follow with 2 bits of state; state 3 (0b11) marks
 *   an extension — 4-bit chunks follow, each `15` adding 15, the final chunk (<15) completing
 *   `state = 3 + sum`. Split nodes follow with 2 bits special side, then their `splits + 1`
 *   children serialized in REVERSE child order.
 *
 * States are channel-dependent: supports/seam use 1 = enforcer, 2 = blocker; colour paint uses the
 * 1-BASED FILAMENT ID. State 0 is unpainted. That id-carrying colour channel is why this module
 * lives in the shared package: both the web editor (brush tools, viewport tinting — see the
 * geometric half in `apps/web/src/plugins/model-studio/lib/trianglePaintTree.ts`) and the bake
 * (`three-mf/bake-documents.ts`, which must re-key base-file paint when a save renumbers the
 * filament slots) read and write these codes, and two codecs would drift.
 *
 * The wire format is BambuStudio's — changing the encoding breaks every file in the field.
 */

export type PaintTreeNode =
  | { kind: 'leaf'; state: number }
  | { kind: 'split'; splits: 1 | 2 | 3; special: 0 | 1 | 2; children: PaintTreeNode[] }

const EXTENSION_MARKER = 3

/** Decode a paint attribute string into its split tree, or null when malformed. */
export function decodePaintTree(code: string): PaintTreeNode | null {
  const bits: boolean[] = []
  for (let i = code.length - 1; i >= 0; i -= 1) {
    const value = Number.parseInt(code[i]!, 16)
    if (!Number.isFinite(value)) return null
    for (let bit = 0; bit < 4; bit += 1) bits.push(Boolean(value & (1 << bit)))
  }
  let cursor = 0
  const read = (count: number): number | null => {
    if (cursor + count > bits.length) return null
    let value = 0
    for (let bit = 0; bit < count; bit += 1) {
      if (bits[cursor + bit]) value |= 1 << bit
    }
    cursor += count
    return value
  }
  const parse = (): PaintTreeNode | null => {
    const splits = read(2)
    if (splits == null) return null
    if (splits === 0) {
      let state = read(2)
      if (state == null) return null
      if (state === EXTENSION_MARKER) {
        state = EXTENSION_MARKER
        let chunk = read(4)
        if (chunk == null) return null
        while (chunk === 15) {
          state += 15
          chunk = read(4)
          if (chunk == null) return null
        }
        state += chunk
      }
      return { kind: 'leaf', state }
    }
    const special = read(2)
    if (special == null || special > 2) return null
    const reversed: PaintTreeNode[] = []
    for (let child = 0; child <= splits; child += 1) {
      const node = parse()
      if (!node) return null
      reversed.push(node)
    }
    return { kind: 'split', splits: splits as 1 | 2 | 3, special: special as 0 | 1 | 2, children: reversed.reverse() }
  }
  const root = parse()
  // Trailing bits are only the implicit nibble padding (always zero in practice).
  return root
}

/** Encode a paint tree back into the reversed-hex attribute string. */
export function encodePaintTree(root: PaintTreeNode): string {
  const bits: boolean[] = []
  const write = (value: number, count: number) => {
    for (let bit = 0; bit < count; bit += 1) bits.push(Boolean(value & (1 << bit)))
  }
  const emit = (node: PaintTreeNode) => {
    if (node.kind === 'leaf') {
      write(0, 2)
      if (node.state >= EXTENSION_MARKER) {
        write(EXTENSION_MARKER, 2)
        let remaining = node.state - EXTENSION_MARKER
        while (remaining >= 15) {
          write(15, 4)
          remaining -= 15
        }
        write(remaining, 4)
      } else {
        write(node.state, 2)
      }
      return
    }
    write(node.splits, 2)
    write(node.special, 2)
    // Children serialized in reverse order (TriangleSelector compatibility).
    for (let child = node.splits; child >= 0; child -= 1) emit(node.children[child]!)
  }
  emit(root)
  let out = ''
  for (let offset = 0; offset < bits.length; offset += 4) {
    let value = 0
    for (let bit = 0; bit < 4; bit += 1) {
      if (bits[offset + bit]) value |= 1 << bit
    }
    out = value.toString(16).toUpperCase() + out
  }
  return out
}

/** True when the tree paints nothing (every leaf is state 0). */
export function isPaintTreeEmpty(node: PaintTreeNode): boolean {
  if (node.kind === 'leaf') return node.state === 0
  return node.children.every(isPaintTreeEmpty)
}

/**
 * Rewrite every COLOUR-paint leaf through a filament-id remap, returning the re-encoded code.
 *
 * Colour paint is the one channel whose leaf `state` IS a filament id (supports/seam use fixed
 * enforcer/blocker constants), so a save that renumbers filaments has to rewrite these codes or the
 * paint silently repoints at whatever material now sits at the old number. That is worse than
 * losing it: the model keeps its painted regions and quietly prints them in the wrong colour.
 *
 * A state the remap cannot translate — its material was removed by this save — becomes 0
 * (unpainted), mirroring how every other seam drops a reference to a deleted material rather than
 * inventing a substitute. State 0 is already unpainted and is never remapped.
 *
 * Returns the input unchanged when the code is malformed or nothing moved, so callers can assign
 * unconditionally without churning identities.
 */
export function remapColorPaintCode(code: string, remap: ReadonlyMap<number, number>): string {
  const root = decodePaintTree(code)
  if (!root) return code
  let changed = false
  const rewrite = (node: PaintTreeNode): PaintTreeNode => {
    if (node.kind === 'leaf') {
      if (node.state === 0) return node
      const moved = remap.get(node.state) ?? 0
      if (moved === node.state) return node
      changed = true
      return { kind: 'leaf', state: moved }
    }
    return { ...node, children: node.children.map(rewrite) }
  }
  const next = rewrite(root)
  if (!changed) return code
  return isPaintTreeEmpty(next) ? '' : encodePaintTree(next)
}

/**
 * Apply {@link remapColorPaintCode} across a whole `colorPaint` map (part key -> triangle -> code),
 * dropping triangles whose paint became empty and parts left with none.
 */
export function remapColorPaintMap(
  paint: Record<string, Record<number, string>>,
  remap: ReadonlyMap<number, number>
): Record<string, Record<number, string>> {
  const out: Record<string, Record<number, string>> = {}
  for (const [partKey, triangles] of Object.entries(paint)) {
    const nextTriangles: Record<number, string> = {}
    for (const [triangleKey, code] of Object.entries(triangles)) {
      const next = remapColorPaintCode(code, remap)
      if (next) nextTriangles[Number(triangleKey)] = next
    }
    if (Object.keys(nextTriangles).length > 0) out[partKey] = nextTriangles
  }
  return out
}

/**
 * Rewrite every `paint_color` attribute in a model entry's XML through a filament-id remap.
 *
 * This is the bake's pass over BASE mesh content — parts the session never painted stream through
 * the save byte-for-byte, so their codes still speak the OLD slot order and only a whole-entry
 * rewrite can catch them (session-touched parts are re-keyed upstream in the edit and then
 * overwrite whatever this wrote, so applying both is safe). A code whose paint empties out has its
 * attribute removed entirely, matching how the paint writer treats an unpainted triangle.
 * Support/seam attributes are untouched: their states are not filament ids.
 */
export function remapColorPaintInModelXml(xml: string, remap: ReadonlyMap<number, number>): string {
  if (!xml.includes('paint_color')) return xml
  return xml.replace(/(\s*)paint_color="([0-9A-Fa-f]*)"/g, (full, whitespace: string, code: string) => {
    const next = remapColorPaintCode(code, remap)
    if (next === code) return full
    return next ? `${whitespace}paint_color="${next}"` : ''
  })
}
