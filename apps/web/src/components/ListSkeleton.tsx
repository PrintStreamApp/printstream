/**
 * Placeholder rows for a list that is still loading.
 *
 * Replaces the word "Loading…", which tells the reader only that something is
 * happening. A skeleton says what is COMING — how many rows, how tall, roughly
 * what shape — so the page stops moving under them when the data lands rather
 * than jumping from one line of text to a full list.
 *
 * Deliberately dumb: no spinner, no timing, no message. It is a shape, and the
 * shape is the information.
 *
 * `ListSection` renders this itself, so most callers never reach for it
 * directly — that is the point. A loading state nobody has to remember is one
 * that cannot drift from the empty and loaded states beside it.
 */
import { Sheet, Skeleton, Stack } from '@mui/joy'

export function ListSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Stack spacing={1} aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }, (_, index) => (
        <Sheet
          key={index}
          variant="outlined"
          sx={{ borderRadius: 'sm', p: 1.5 }}
        >
          <Stack spacing={0.75}>
            {/* Two lines, uneven: a title and its supporting text. Equal bars
                read as a table and mislead about what is arriving. */}
            <Skeleton variant="text" level="title-sm" sx={{ width: '38%' }} />
            <Skeleton variant="text" level="body-xs" sx={{ width: '62%' }} />
          </Stack>
        </Sheet>
      ))}
    </Stack>
  )
}
