export function sanitizeProfileFileName(value: string): string {
  return value.replace(/[\\/:;]/g, '-')
}