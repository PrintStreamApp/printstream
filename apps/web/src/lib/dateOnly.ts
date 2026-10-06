/** Date-only editorial values use Toronto's calendar without inheriting a reader's timezone. */
export function formatDateOnly(value: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    dateStyle: 'long'
  }).format(new Date(`${value}T12:00:00Z`))
}
