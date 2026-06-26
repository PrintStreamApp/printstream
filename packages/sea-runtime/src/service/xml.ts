/**
 * Minimal XML text escaping for the WinSW service-config generator
 * (`service/winsw.ts`). Kept tiny and dependency-free.
 */
export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
