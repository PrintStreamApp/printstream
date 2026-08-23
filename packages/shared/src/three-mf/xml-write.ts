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
