# Active Print Resolution Paths

This document explains how PrintStream resolves the three confusing pieces of active-print UI state:

- the active job label shown on the printer card
- the active cover image
- the active skip-object list

It also records what is currently known to work, what still falls back, and what evidence each path depends on.

## Terms

- Live status: the current `PrinterStatus` reported by the printer bridge and exposed through `/api/printers` plus WS updates.
- Tracked job: the unfinished `PrintJob` row in the database for the active task.
- Local source: a PrintStream-owned local 3MF path, usually from library or dispatched prints.
- Printer archive path: an exact `.3mf` path visible on printer storage over FTPS.
- Metadata path: a printer-reported path like `/data/Metadata/plate_4.gcode`. This is a plate hint, not the real archive.

## Evidence Sources

The active-print paths combine evidence from four places:

1. Live printer status (`jobName`, `gcodeFile`, `taskId`, stage)
2. The unfinished `PrintJob` row for the active task
3. Any PrintStream local source file remembered for that job
4. Printer-side FTPS listing and 3MF metadata

The resolution quality depends on how many of those four sources are available.

## Active Label Path

### Web card priority

The printer card does not rely on a single source.

It resolves the displayed active label in this order:

1. Formatted live status label from `status.jobName` and `status.gcodeFile`
2. Formatted unfinished tracked-job label from `/api/jobs` when the live label is clearly a generic fallback
3. Latest finished job label
4. Raw live/history fallback string

The important detail is that the web now prefers the unfinished tracked job only when the live label suffix is a generic fallback such as `plate_4` or `Plate 4`. That keeps genuine live names authoritative while still allowing the DB-backed label to improve metadata-only external prints.

Relevant modules:

- `apps/web/src/pages/PrintersView.tsx`
- `apps/web/src/lib/trackedPrintJobs.ts`
- `apps/web/src/lib/printerJobName.ts`

### How the unfinished tracked label is created

For external prints, the recorder now tries to enrich the unfinished `PrintJob` row during status reconciliation.

The flow is:

1. External active status arrives with `taskId`, `jobName`, and `gcodeFile`
2. The recorder prefers the printer's `status.jobName` instead of deriving only from `gcodeFile`
3. If the printer only reports a metadata path, the recorder tries to resolve the real `.3mf` archive path from printer storage
4. If that archive resolves and a 3MF plate name exists for the active plate, the recorder rewrites the unfinished job label from a generic `... - plate_4` form to the actual plate name

Relevant module:

- `apps/api/src/lib/print-job-recorder.ts`

### When the label still falls back to `Plate N`

`Plate 4` is not the intended best-case display for an external print. It is the fallback when the richer path cannot be completed.

That fallback still happens if any of these are true:

- the printer only exposed a metadata path and no real archive could be matched
- the archive was matched, but the active plate had no name in the 3MF index
- the live status and tracked row are both still generic
- the UI is reading stale data from an older session or stale browser tab

## Cover Image Path

The active cover route is `GET /api/printers/:id/cover`.

It resolves the cover in this order:

1. PrintStream dispatch-time local source cache
2. PrintStream persisted local source from the tracked job
3. Exact printer archive path from live status or tracked job
4. Resolved printer archive path via fuzzy archive matching
5. Persisted thumbnail fallback from finished job history

Important details:

- Bambu's LAN status does not include a usable embedded thumbnail
- metadata paths are not enough on their own, so the route tries to recover a real `.3mf`
- printer-archive resolution uses exact candidates first, then fuzzy matching based on normalized job name and plate index

Relevant modules:

- `apps/api/src/routes/printers.ts`
- `apps/api/src/lib/printer-cover-source.ts`
- `apps/api/src/lib/active-print-job-assets.ts`

## Skip-Object Path

Skip objects are loaded by the active-print object cache and exposed through the active-print object route.

The resolution order is:

1. Metadata-based object read from printer storage when possible
2. PrintStream local source 3MF
3. Exact or resolved printer archive path 3MF
4. Empty object list fallback

Important details:

- metadata-only H2D paths are not themselves enough for full object extraction
- the object loader now uses the same archive matcher used by the cover path when only metadata hints are available
- the cache stores results per printer, job name, `gcodeFile`, and task id so the UI can open the skip dialog without redoing all FTPS work every time

Relevant modules:

- `apps/api/src/lib/active-print-objects.ts`
- `apps/api/src/lib/printer-cover-source.ts`
- `apps/api/src/lib/active-print-job-assets.ts`

## Storage Print Path

Printer-storage initiated prints are a separate path from external prints.

For `/api/printers/:id/storage/print`, PrintStream now preserves the selected 3MF plate name when it creates or updates the active tracked job. This fixed a regression where storage-started prints fell back to generic plate labels even though PrintStream knew the selected plate.

Relevant route:

- `apps/api/src/routes/printers.ts`

## What Is Known To Work

These behaviors were verified during the recent regression work:

- PrintStream-dispatched prints remain the strongest path because they have local source files, tracked jobs, and stable metadata
- printer-storage prints preserve the selected 3MF plate name in the active job label
- external prints with only metadata `gcodeFile` hints can now recover active cover images if the printer archive matcher finds the real `.3mf`
- external prints with only metadata `gcodeFile` hints can now recover skip-object data through the same archive matcher path
- external unfinished tracked jobs can now be enriched from the printer archive and 3MF plate metadata instead of always collapsing to `plate_N`

## What Is Still Expected To Fall Back

These cases still legitimately degrade to generic labels or missing assets:

- the printer exposes only a metadata path and no matching `.3mf` can be found on printer storage
- the printer archive exists but its 3MF plate index does not provide a useful plate name
- the active job is visible only through proprietary internal metadata that does not expose the full sliced object list
- the browser is showing an old tab or stale dev session that is no longer connected to the current API/runtime

In those cases:

- the label may stay `Plate N`
- the cover may fall back to history or be absent
- skip objects may be unavailable

## Debug Checklist

When an active print looks wrong, check these in order:

1. Is the browser tab connected to the intended API/web session?
2. What do live status `jobName`, `gcodeFile`, and `taskId` say?
3. Does the unfinished `PrintJob` row for that task have `jobName`, `plate`, and `printerFilePath`?
4. Can `resolvePrinterCoverPath()` match a real `.3mf` on printer storage?
5. Does the matched 3MF contain a plate name for the active plate?
6. Is the print a BH-dispatched, printer-storage, or truly external print?

The answer to those six questions usually explains the result without needing broad repo archaeology.