/**
 * Minimal XML text escaping shared by the service definition generators (the
 * WinSW config) and the tray autostart entries. Kept tiny and dependency-free.
 */
export function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
