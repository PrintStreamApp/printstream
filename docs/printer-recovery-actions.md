# Printer Recovery Actions

PrintStream mirrors BambuStudio's recovery action families for Bambu printers. Keep these cases explicit so UI affordances, shared availability helpers, and API MQTT payloads do not drift apart.

## Action Families

| User-facing state | Shared action id | Button label | API command | MQTT payload shape | Notes |
| --- | --- | --- | --- | --- | --- |
| Normal paused print, no active filament-change step | `resume` | Resume | `resume` | `print.command = "resume"` | This is the standard paused-print resume path. |
| Paused print with a device/HMS warning that can be resumed through the warning id | `resume` | Resume | `resume` | `print.command = "resume"`, `err`, `param = "reserve"`, `job_id` when the printer reports a job id | Keep this separate from Ignore/Continue. |
| Paused print with a non-runout warning where the user deliberately bypasses the warning | `ignoreHmsError` | Continue | `ignoreHmsError` | `print.command = "ignore"`, `err`, `param = "reserve"`, `job_id` | Show only when the printer reports `job_id`; do not show this for filament runout or warning states that cannot produce Bambu's ignore payload. |
| Paused AMS filament runout before a filament-change step is active | `resume` | Resume | `resume` | `resume` with warning payload when `job_id` is available; otherwise `clean_print_error` then `resume` | BambuStudio still presents Resume here. The HMS Continue/ignore path must stay hidden. |
| Paused AMS filament runout with configured alternate source available | `loadFilament` | Load filament | `loadAmsFilament` / `loadExternalSpool` | `print.command = "ams_change_filament"` | This is an extra PrintStream helper. It does not replace Resume. |
| Waiting for AMS extrusion confirmation | `retryAmsFilamentChange` | Retry | `retryAmsFilamentChange` | `print.command = "ams_control"`, `param = "resume"` | This is the AMS-control retry path, not normal print resume. |
| Waiting for AMS extrusion confirmation | `confirmAmsFilamentExtruded` | Continue | `confirmAmsFilamentExtruded` | `print.command = "ams_control"`, `param = "done"` | This is the AMS-control done path, not HMS ignore. |
| Paused or failed state with device/HMS warning | `checkAssistant` | Check assistant | none | none | Opens the assistant/details flow. |
| Paused or failed state with device/HMS warning | `jumpToLiveView` | Live view | none | none | Shared helper may expose this, but the printer-card footer intentionally omits it because the app has a separate live-view entry point. |
| Active print stage | `stop` | Stop | `stop` | `print.command = "stop"` | Available for active job stages, including paused. |

## Filament Runout Detection

Treat a paused status as filament runout when either condition is true:

- `subStage === "6"`, BambuStudio's paused-filament-runout substage.
- The device error or HMS message says the filament ran out or has run out. Some printers report AMS runout as `subStage === "4"` (`Changing filament`) with messages such as `AMS filament ran out. Please insert a new filament into the same AMS slot.`

This broader detection is only for hiding the HMS Continue/ignore path and showing runout guidance. Do not use it to hide Resume.

## Footer Policy

The printer-card footer should show immediate print-control actions only. For the current Bambu path that means:

- Show `Resume` for paused runout states unless the printer is already busy in a filament-change step.
- Hide `Continue`/`ignoreHmsError` for filament runout and for paused warning states without `job_id`.
- Show `Retry` and AMS `Continue` only while waiting for extrusion confirmation.
- Keep `Live view` out of the footer; use the existing camera/live-view entry point instead.

## Assistant Error Details

When HMS entries are present, the assistant should list the HMS entries and not also list the device-level error. The device error is useful for card summaries and command gating, but BambuStudio-style troubleshooting is driven by the HMS detail code/message when the printer reports one. Fall back to the device error only when no HMS entries are available.

## Snapshot Policy

Do not pause camera snapshots just because a cover image is still loading once the printer is paused. Paused warning states are exactly when the operator needs the camera most. Cover-loading may defer snapshots during active non-paused print stages to reduce competing media work, but paused/error recovery states should keep camera updates live.

When adding a recovery state, update `packages/shared/src/printer.test.ts` and the API command tests in `apps/api/src/routes/printers-auth.test.ts` for the shared action list and MQTT payload family.