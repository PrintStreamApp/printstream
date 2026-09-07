/**
 * XML/regex escaping primitives for the 3MF *writers*.
 *
 * The counterpart of the parsers' `parseAttrs`: everything that rewrites a 3MF entry needs to put
 * user-supplied text (object names, source-file names, filament colours) back into XML attributes
 * safely, and needs to build regexes around ids it read out of the document.
 *
 * Lives in shared rather than the API because the bake runs in two places: the API (yauzl/yazl
 * over a file on disk) and the browser (fflate over bytes the user picked). Keep this Node-free.
 */

/** Escape a string for use as an XML attribute VALUE (already-quoted with `"`). */
export function escapeXmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Escape a string for literal use inside a `RegExp` (entry paths, ids, attribute values). */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Read one double-quoted XML attribute out of an element (or an attribute run), RAW.
 *
 * The reading counterpart of {@link escapeXmlAttribute}, which is why it lives here. Extracted
 * because it had reached three byte-identical copies (`text-info.ts`, `svg-shape.ts`,
 * `layer-config-ranges.ts`), each parsing a different 3MF sidecar: a fix to one, say accepting
 * single-quoted attributes, would silently have missed the other two.
 *
 * Returns the value UNDECODED. Callers decide, because they differ: most want
 * {@link decodeXmlAttributeValue}, while numeric and enum readers parse the raw text and would only
 * pay for a decode that cannot change their answer.
 */
export function xmlAttribute(source: string, name: string): string | null {
  const match = new RegExp(`\\b${name}="([^"]*)"`).exec(source)
  return match ? match[1]! : null
}

/**
 * Read a numeric XML attribute, falling back when it is absent or not finite.
 *
 * Shared with {@link xmlAttribute} for the same reason: the "absent or unparseable means the
 * caller's default" rule is one rule, and each sidecar parser had its own copy of it.
 */
export function xmlNumberAttribute(source: string, name: string, fallback: number): number {
  const raw = xmlAttribute(source, name)
  if (raw == null) return fallback
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : fallback
}

/** Decode XML/HTML entity escapes in an attribute value. The inverse of escapeXmlAttribute, so the two live together. */
export function decodeXmlAttributeValue(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#\d+|apos|quot|amp|lt|gt);/g, (entity, body: string) => {
    switch (body) {
      case 'apos':
        return '\''
      case 'quot':
        return '"'
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      default: {
        const radix = body.startsWith('#x') ? 16 : 10
        const codePoint = Number.parseInt(body.replace(/^#x?/i, ''), radix)
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity
      }
    }
  })
}
