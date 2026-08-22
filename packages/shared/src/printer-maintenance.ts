/**
 * Printer maintenance catalog: what Bambu recommends servicing on each printer
 * model, how often, and whether the job wants oil, grease, or neither.
 *
 * Owns two things and nothing else:
 *
 * 1. The **catalog** — a set of named schedules plus a model-key -> schedule map.
 *    Every interval here is copied from Bambu's own wiki page for that model
 *    (each schedule carries the `wikiUrl` it came from). Nothing is invented: a
 *    job Bambu describes only by symptom ("when squeaking", "when under-
 *    extruding") is either omitted or carries no interval, because a made-up
 *    number reads exactly like a sourced one once it is on screen.
 * 2. The **due math** — `evaluateMaintenanceTask`, which turns a task
 *    definition + the user's overrides + the last completion into a status.
 *
 * Contract for callers: a task can be driven by up to three interval kinds
 * (calendar days, print hours, filament kilograms) and is due when the FIRST of
 * them elapses. Bambu states the trigger in different units per job — "every
 * three months", "every 200 print hours", "every 3 rolls" — and one roll is one
 * kilogram, which is why filament mass is a first-class trigger rather than a
 * spool counter. Usage triggers read `PrinterStats`, whose filament totals are
 * null when no print recorded filament use, so a trigger whose metric is
 * unavailable is reported as such and never silently treated as zero progress.
 *
 * **Adding a printer model** (this is the part that has to stay cheap): add the
 * model key to `MODEL_MAINTENANCE_SCHEDULE_IDS`, pointing at an existing
 * schedule if Bambu ships it the same page, or at a new entry in
 * `PRINTER_MAINTENANCE_SCHEDULES`. `printer-maintenance.test.ts` fails when a
 * key in `KNOWN_BAMBU_PRINTER_MODEL_KEYS` has no mapping, so a model added to
 * `bambu-model-keys.ts` cannot silently ship with no schedule. Until a model is
 * classified — and for any printer that is not a recognized Bambu at all — the
 * `generic` schedule stands in; it is flagged `generic: true` so the UI can say
 * plainly that the intervals are not model-specific.
 *
 * Task keys are a **persisted identifier** (they key the maintenance rows and
 * their history), so renaming one needs a data migration. Keys are shared across
 * schedules where the job is the same job, so history reads consistently.
 */
import { KNOWN_BAMBU_PRINTER_MODEL_KEYS, canonicalBambuModelKey } from './bambu-model-keys.js'

/** What the job wants applied. `none` is meaningful: some parts are damaged by grease. */
export type MaintenanceLubricant = 'oil' | 'grease' | 'none'

/** Which measure drives an interval. All three are "whichever elapses first". */
export type MaintenanceTriggerKind = 'days' | 'printHours' | 'filamentKilograms'

export interface MaintenanceTaskDefinition {
  /** Stable persisted key. Shared across schedules when the job is the same job. */
  key: string
  title: string
  /** One line on what the job is and any hazard in doing it wrong. */
  summary: string
  lubricant: MaintenanceLubricant
  intervalDays?: number
  intervalPrintHours?: number
  intervalFilamentKilograms?: number
  /**
   * Bambu's wording for the interval, shown verbatim. Their guidance is often a
   * range ("every 3-5 rolls") or conditional ("every 2 rolls for carbon fibre"),
   * and the numeric interval takes the conservative end — this preserves what
   * was actually said so the shortened figure is not mistaken for the whole rule.
   */
  intervalNote?: string
  /**
   * Canonical 16-char HMS codes (`formatHmsCode` form) that mean the printer is
   * asking for THIS job. When one is active the task is due regardless of its
   * intervals — the machine's own counter outranks ours.
   */
  hmsCodes?: readonly string[]
}

export interface MaintenanceSchedule {
  id: string
  label: string
  /** The Bambu wiki page every interval in this schedule was taken from. */
  wikiUrl: string
  /** Set when the schedule stands in for a model that is not in the catalog. */
  generic?: boolean
  tasks: readonly MaintenanceTaskDefinition[]
}

/** HMS code raised by H2-series printers asking for Z lead screw grease. */
const HMS_LUBRICATE_Z_LEAD_SCREW = '0501040000030002'

const WIKI = {
  x1: 'https://wiki.bambulab.com/en/x1/maintenance/basic-maintenance',
  p1: 'https://wiki.bambulab.com/en/p1/maintenance/p1p-maintenance',
  a1: 'https://wiki.bambulab.com/en/a1/maintenance/basic-maintenance',
  a2l: 'https://wiki.bambulab.com/en/a2l/maintenance/period-maintenance',
  p2s: 'https://wiki.bambulab.com/en/p2s/maintenance/period-maintenance',
  h2d: 'https://wiki.bambulab.com/en/h2/maintenance/period-maintenance',
  h2c: 'https://wiki.bambulab.com/en/h2c/maintenance/period-maintenance',
  h2s: 'https://wiki.bambulab.com/en/h2s/maintenance/period-maintenance',
  index: 'https://wiki.bambulab.com/en/general/lead-screws-lubrication'
} as const

const DAYS_PER_MONTH = 30

/** Shared task bodies. Interval fields are supplied per schedule. */
const CUTTER_SUMMARY = 'Check the filament cutter blade and replace it if it has gone dull.'
const EXTRUDER_GEAR_SUMMARY = 'Clear filament dust from the extruder gear.'
const PTFE_SUMMARY = 'Inspect the PTFE tube for wear and replace it if the bore is scored.'

const SCHEDULES = {
  x1: {
    id: 'x1',
    label: 'X1 series',
    wikiUrl: WIKI.x1,
    tasks: [
      {
        key: 'x-axis',
        title: 'Clean the X-axis carbon rods',
        summary: 'Wipe the carbon rods with isopropyl alcohol. Never grease them — grease causes binding and is very hard to remove.',
        lubricant: 'none',
        intervalDays: DAYS_PER_MONTH,
        intervalNote: 'Monthly, or every 5 rolls when printing ABS/ASA.'
      },
      {
        key: 'linear-rods-clean',
        title: 'Clean the Y and Z linear rods',
        summary: 'Wipe the rods down with isopropyl alcohol and a lint-free cloth.',
        lubricant: 'none',
        intervalDays: DAYS_PER_MONTH,
        intervalNote: 'Monthly, or every 5 rolls when printing ABS/ASA.'
      },
      {
        key: 'linear-rods-antirust',
        title: 'Anti-rust the Y and Z linear rods',
        summary: 'Wipe the rods with anti-rust oil on a lint-free cloth.',
        lubricant: 'oil',
        intervalDays: 3 * DAYS_PER_MONTH
      },
      {
        key: 'z-lead-screw',
        title: 'Grease the Z-axis lead screws',
        summary: 'Clean the three lead screws, then work a thin coat of grease along them by moving the bed through its range.',
        lubricant: 'grease',
        intervalDays: 3 * DAYS_PER_MONTH
      },
      {
        key: 'extruder-gear',
        title: 'Clean the extruder gear',
        summary: EXTRUDER_GEAR_SUMMARY,
        lubricant: 'none',
        intervalDays: 7
      },
      {
        key: 'filament-cutter',
        title: 'Check the filament cutter blade',
        summary: CUTTER_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 3,
        intervalNote: 'Every 3-5 rolls; every 1-2 rolls of abrasive filament. Blades also dull after roughly 5,000-7,000 cuts.'
      },
      {
        key: 'air-filter',
        title: 'Replace the activated carbon air filter',
        summary: 'Swap the filter cartridge out for a fresh one.',
        lubricant: 'none',
        intervalDays: 3 * DAYS_PER_MONTH,
        intervalNote: 'Every 3 months at about 8 hours a day; monthly for a production machine.'
      }
    ]
  },

  p1: {
    id: 'p1',
    label: 'P1 series',
    wikiUrl: WIKI.p1,
    tasks: [
      {
        key: 'x-axis',
        title: 'Clean the X-axis carbon rods',
        summary: 'Wipe the carbon rods with isopropyl alcohol. Never grease them — grease causes binding and is very hard to remove.',
        lubricant: 'none',
        intervalDays: DAYS_PER_MONTH
      },
      {
        key: 'linear-rods-clean',
        title: 'Clean the Y and Z linear rods',
        summary: 'Wipe the rods down with isopropyl alcohol and a lint-free cloth.',
        lubricant: 'none',
        intervalDays: DAYS_PER_MONTH,
        intervalNote: 'Monthly, or every 5 rolls when printing ABS/ASA.'
      },
      {
        key: 'linear-rods-antirust',
        title: 'Anti-rust the Y and Z linear rods',
        summary: 'Wipe the rods with anti-rust oil on a lint-free cloth.',
        lubricant: 'oil',
        intervalDays: 3 * DAYS_PER_MONTH
      },
      {
        key: 'z-lead-screw',
        title: 'Grease the Z-axis lead screws',
        summary: 'Clean the lead screws, then work a thin coat of grease along them by moving the bed through its range.',
        lubricant: 'grease',
        intervalDays: 3 * DAYS_PER_MONTH
      },
      {
        key: 'filament-cutter',
        title: 'Check the filament cutter blade',
        summary: CUTTER_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 3,
        intervalNote: 'Every 3-5 rolls; every 1-2 rolls of abrasive filament.'
      },
      {
        key: 'ptfe-tube',
        title: 'Check the PTFE tube',
        summary: PTFE_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 10,
        intervalNote: 'Every 10 rolls; every 5 rolls of abrasive filament.'
      }
    ]
  },

  a1: {
    id: 'a1',
    label: 'A1 series',
    wikiUrl: WIKI.a1,
    tasks: [
      {
        key: 'x-axis',
        title: 'Clean and oil the X-axis rail',
        summary: 'Clear debris from the rail, then apply lubricant OIL and run the toolhead end to end. Grease is prohibited on this rail.',
        lubricant: 'oil',
        intervalDays: DAYS_PER_MONTH
      },
      {
        key: 'y-axis',
        title: 'Clean and oil the Y-axis rails',
        summary: 'Clear debris from both rails, then apply lubricant oil and run the heatbed back and forth.',
        lubricant: 'oil',
        intervalDays: DAYS_PER_MONTH,
        intervalNote: 'Bambu switched the A1 Y-axis from grease to oil; wipe old grease off before oiling.'
      },
      {
        key: 'z-lead-screw',
        title: 'Grease the Z-axis lead screws',
        summary: 'Apply grease to the working area of both lead screws and raise/lower the X-axis to spread it.',
        lubricant: 'grease',
        intervalDays: 3 * DAYS_PER_MONTH
      },
      {
        key: 'idler-pulleys',
        title: 'Oil the X and Y idler pulleys',
        summary: 'Apply a drop of oil between the belt and each idler pulley.',
        lubricant: 'oil',
        intervalDays: 3 * DAYS_PER_MONTH
      },
      {
        key: 'extruder-gear',
        title: 'Clean the extruder gear',
        summary: EXTRUDER_GEAR_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 5,
        intervalNote: 'Every 5 spools; every 2 spools of carbon-fibre filament.'
      },
      {
        key: 'filament-cutter',
        title: 'Check the filament cutter blade',
        summary: CUTTER_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 3,
        intervalNote: 'Every 3 rolls of PLA/ABS/PETG.'
      },
      {
        key: 'ptfe-tube',
        title: 'Check the PTFE tube',
        summary: PTFE_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 6,
        intervalNote: 'Every 6 rolls; every 2 rolls of carbon-fibre or wood-filled filament.'
      }
    ]
  },

  a2l: {
    id: 'a2l',
    label: 'A2L',
    wikiUrl: WIKI.a2l,
    tasks: [
      {
        key: 'x-axis',
        title: 'Clean and lubricate the X-axis guide rail',
        summary: 'Clear debris from the rail, then apply lubricant oil.',
        lubricant: 'oil',
        intervalDays: DAYS_PER_MONTH
      },
      {
        key: 'y-axis',
        title: 'Clean and lubricate the Y-axis guide rail',
        summary: 'Clear debris from the rail, then apply lubricant oil. Do this once after unboxing, then on the hours interval.',
        lubricant: 'oil',
        intervalPrintHours: 200,
        intervalNote: 'After initial setup, then every 200 print hours. The printer also raises an HMS reminder.'
      },
      {
        key: 'z-lead-screw',
        title: 'Grease the Z-axis lead screw',
        summary: 'Clean the lead screw and apply fresh grease.',
        lubricant: 'grease',
        intervalDays: 3 * DAYS_PER_MONTH
      },
      {
        key: 'extruder-gear',
        title: 'Clean the extruder gear',
        summary: EXTRUDER_GEAR_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 5,
        intervalNote: 'Every 5 spools; every 2 spools of carbon-fibre filament.'
      },
      {
        key: 'filament-cutter',
        title: 'Check the filament cutter blade',
        summary: CUTTER_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 3,
        intervalNote: 'Every 3 spools of PLA/ABS/PETG.'
      },
      {
        key: 'ptfe-tube',
        title: 'Check the PTFE tube',
        summary: PTFE_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 6,
        intervalNote: 'Every 6 spools; every 2 spools of carbon-fibre or wood-filled filament.'
      }
    ]
  },

  p2s: {
    id: 'p2s',
    label: 'P2S / X2D',
    wikiUrl: WIKI.p2s,
    tasks: [
      {
        key: 'xy-axis',
        title: 'Clean and lubricate the XY axes',
        summary: 'Full XY clean and re-lubrication. Apply oil in drops along each shaft, 1-2 drops every 5 cm.',
        lubricant: 'oil',
        intervalDays: 2 * DAYS_PER_MONTH,
        intervalNote: 'Bambu tiers this by usage: monthly at 5+ printing hours a day, every 2 months at 1-5, every 3 months below 1. The default here is the middle tier — adjust it to match how hard this printer runs.'
      },
      {
        key: 'z-axis',
        title: 'Deep-clean and lubricate the Z axis',
        summary: 'Full Z-axis service: clean the screws and rods, then re-lubricate.',
        lubricant: 'grease',
        intervalDays: 4 * DAYS_PER_MONTH,
        intervalNote: 'Bambu tiers this by usage: every 3 months at 5+ printing hours a day, every 4 months at 1-5, every 5 months below 1. The default here is the middle tier.'
      },
      {
        key: 'filament-cutter',
        title: 'Check the filament cutter blade',
        summary: CUTTER_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 8,
        intervalNote: 'Every 8-12 spools; every 4-10 spools of abrasive filament.'
      }
    ]
  },

  h2d: {
    id: 'h2d',
    label: 'H2D / H2D Pro',
    wikiUrl: WIKI.h2d,
    tasks: [
      {
        key: 'x-axis',
        title: 'Clean and oil the X-axis assembly',
        summary: 'Clean the assembly, then apply lubricant oil.',
        lubricant: 'oil',
        intervalDays: DAYS_PER_MONTH
      },
      {
        key: 'y-axis',
        title: 'Clean and oil the Y-axis linear rods',
        summary: 'Clean the rods, then apply lubricant oil.',
        lubricant: 'oil',
        intervalDays: DAYS_PER_MONTH
      },
      {
        key: 'z-axis',
        title: 'Clean and grease the Z-axis rods and lead screws',
        summary: 'All three sets of rods and screws: oil on the linear rods, grease on the lead screws. Do not mix the two up.',
        lubricant: 'grease',
        intervalDays: DAYS_PER_MONTH,
        hmsCodes: [HMS_LUBRICATE_Z_LEAD_SCREW]
      },
      {
        key: 'nozzle-lift-rail',
        title: 'Clean and oil the left nozzle lift rail',
        summary: 'Clean the extruder lifting rail, then apply lubricant oil.',
        lubricant: 'oil',
        intervalDays: DAYS_PER_MONTH
      },
      {
        key: 'extruder-gear',
        title: 'Clean the extruder gear',
        summary: EXTRUDER_GEAR_SUMMARY,
        lubricant: 'none',
        intervalDays: 7
      },
      {
        key: 'filament-cutter',
        title: 'Check the filament cutter blade',
        summary: CUTTER_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 3,
        intervalNote: 'Every 3-5 rolls; every 1-2 rolls of abrasive filament.'
      }
    ]
  },

  h2c: {
    id: 'h2c',
    label: 'H2C',
    wikiUrl: WIKI.h2c,
    tasks: [
      {
        key: 'x-axis',
        title: 'Clean and lubricate the X-axis rail',
        summary: 'Clean the rail, then apply lubricant oil.',
        lubricant: 'oil',
        intervalDays: DAYS_PER_MONTH
      },
      {
        key: 'y-axis',
        title: 'Clean and lubricate the Y-axis linear rod',
        summary: 'Clean the rod, then apply lubricant oil.',
        lubricant: 'oil',
        intervalDays: 3 * DAYS_PER_MONTH
      },
      {
        key: 'z-axis',
        title: 'Clean and lubricate the Z-axis lead screw and linear rod',
        summary: 'Oil on the linear rod, grease on the lead screw. Do not mix the two up.',
        lubricant: 'grease',
        intervalDays: 3 * DAYS_PER_MONTH,
        hmsCodes: [HMS_LUBRICATE_Z_LEAD_SCREW]
      },
      {
        key: 'nozzle-lift-rail',
        title: 'Clean and lubricate the left nozzle lifting rail',
        summary: 'Clean the lifting rail, then apply lubricant oil.',
        lubricant: 'oil',
        intervalDays: DAYS_PER_MONTH
      },
      {
        key: 'hotend-rack',
        title: 'Service the induction hotend rack',
        summary: 'Clean and lubricate the induction hotend rack.',
        lubricant: 'oil',
        intervalDays: DAYS_PER_MONTH
      },
      {
        key: 'extruder-gear',
        title: 'Clean the extruder gear',
        summary: EXTRUDER_GEAR_SUMMARY,
        lubricant: 'none',
        intervalDays: 7
      },
      {
        key: 'filament-cutter',
        title: 'Check the filament cutter blade',
        summary: CUTTER_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 3,
        intervalNote: 'Every 3-5 rolls; every 1-2 rolls of abrasive filament.'
      }
    ]
  },

  h2s: {
    id: 'h2s',
    label: 'H2S',
    wikiUrl: WIKI.h2s,
    tasks: [
      {
        key: 'x-axis',
        title: 'Clean and oil the X-axis linear guideway',
        summary: 'Clean the guideway, then apply lubricant oil.',
        lubricant: 'oil',
        intervalDays: DAYS_PER_MONTH
      },
      {
        key: 'y-axis',
        title: 'Clean and oil the Y-axis linear rod',
        summary: 'Clean the rod, then apply lubricant oil.',
        lubricant: 'oil',
        intervalDays: 3 * DAYS_PER_MONTH
      },
      {
        key: 'z-axis',
        title: 'Clean and grease the Z-axis lead screw and linear rod',
        summary: 'Oil on the linear rod, grease on the lead screw. Do not mix the two up.',
        lubricant: 'grease',
        intervalDays: 3 * DAYS_PER_MONTH,
        hmsCodes: [HMS_LUBRICATE_Z_LEAD_SCREW]
      },
      {
        key: 'extruder-gear',
        title: 'Clean the extruder gear',
        summary: EXTRUDER_GEAR_SUMMARY,
        lubricant: 'none',
        intervalDays: 7
      },
      {
        key: 'filament-cutter',
        title: 'Check the filament cutter blade',
        summary: CUTTER_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 3,
        intervalNote: 'Every 3-5 spools; every 1-2 spools of abrasive filament.'
      }
    ]
  },

  generic: {
    id: 'generic',
    label: 'General guidance',
    wikiUrl: WIKI.index,
    generic: true,
    tasks: [
      {
        key: 'x-axis',
        title: 'Clean and lubricate the X axis',
        summary: 'Clean the X-axis rail or rods. Check your printer\'s wiki page for whether it wants oil, grease, or neither — some rails are damaged by grease.',
        lubricant: 'none',
        intervalDays: DAYS_PER_MONTH
      },
      {
        key: 'y-axis',
        title: 'Clean and lubricate the Y axis',
        summary: 'Clean the Y-axis rail or rods and lubricate as your printer\'s wiki page directs.',
        lubricant: 'none',
        intervalDays: DAYS_PER_MONTH
      },
      {
        key: 'z-lead-screw',
        title: 'Grease the Z-axis lead screws',
        summary: 'Clean the lead screws and apply fresh grease.',
        lubricant: 'grease',
        intervalDays: 3 * DAYS_PER_MONTH
      },
      {
        key: 'filament-cutter',
        title: 'Check the filament cutter blade',
        summary: CUTTER_SUMMARY,
        lubricant: 'none',
        intervalFilamentKilograms: 3
      }
    ]
  }
} satisfies Record<string, MaintenanceSchedule>

export const PRINTER_MAINTENANCE_SCHEDULES: Readonly<Record<string, MaintenanceSchedule>> = Object.freeze(SCHEDULES)

/**
 * Which schedule each canonical Bambu model key uses. Models share an entry only
 * where Bambu ships them the same wiki page — the H2 models each publish their
 * own table and genuinely differ (H2D wants Y and Z monthly where H2C/H2S want
 * them quarterly), so they are not one family here even though they are one
 * family for slicing.
 */
export const MODEL_MAINTENANCE_SCHEDULE_IDS: Readonly<Record<string, string>> = Object.freeze({
  X1: 'x1',
  X1C: 'x1',
  X1E: 'x1',
  P1P: 'p1',
  P1S: 'p1',
  A1: 'a1',
  A1mini: 'a1',
  A2L: 'a2l',
  P2S: 'p2s',
  X2D: 'p2s',
  H2D: 'h2d',
  H2DPRO: 'h2d',
  H2C: 'h2c',
  H2S: 'h2s'
})

export const GENERIC_MAINTENANCE_SCHEDULE: MaintenanceSchedule = SCHEDULES.generic

/**
 * Resolve the schedule for a printer model string (any form
 * `canonicalBambuModelKey` accepts). Falls back to the `generic` schedule —
 * flagged `generic: true` — for an unrecognized or not-yet-classified model, so
 * a printer released after this build still tracks something rather than
 * showing an empty list.
 */
export function resolveMaintenanceSchedule(model: string | null | undefined): MaintenanceSchedule {
  const key = canonicalBambuModelKey(model)
  const scheduleId = key ? MODEL_MAINTENANCE_SCHEDULE_IDS[key] : undefined
  return (scheduleId ? PRINTER_MAINTENANCE_SCHEDULES[scheduleId] : undefined) ?? GENERIC_MAINTENANCE_SCHEDULE
}

/** Model keys with no schedule mapping. Empty in a correct build; the test asserts it. */
export function unclassifiedMaintenanceModelKeys(): string[] {
  return KNOWN_BAMBU_PRINTER_MODEL_KEYS.filter((key) => !(key in MODEL_MAINTENANCE_SCHEDULE_IDS))
}

/** Per-printer user overrides. `null` on an interval clears it; `undefined` keeps the catalog value. */
export interface MaintenanceTaskOverride {
  intervalDays?: number | null
  intervalPrintHours?: number | null
  intervalFilamentKilograms?: number | null
  disabled?: boolean
}

/** The last time this task was marked done, with the usage counters as they read then. */
export interface MaintenanceCompletion {
  completedAt: Date
  printHours: number | null
  filamentKilograms: number | null
}

/** Live usage counters for the printer, straight off `PrinterStats`. */
export interface MaintenanceUsage {
  printHours: number | null
  filamentKilograms: number | null
}

export type MaintenanceStatus = 'disabled' | 'not-logged' | 'ok' | 'due-soon' | 'due'

export interface MaintenanceTrigger {
  kind: MaintenanceTriggerKind
  interval: number
  /** How much has accrued since the last completion, or null when unmeasurable. */
  elapsed: number | null
  /** `elapsed / interval`, or null when unmeasurable. */
  progress: number | null
  /** Calendar date this trigger comes due. Only ever set for the `days` trigger. */
  dueAt: Date | null
  /**
   * Set when the metric this trigger needs is not being recorded — filament mass
   * with no tracked prints, for instance. The trigger is inert rather than
   * treated as zero progress.
   */
  unavailable: boolean
}

export interface MaintenanceEvaluation {
  status: MaintenanceStatus
  /** Highest trigger progress, so 1 means due and 1.5 means half an interval overdue. */
  progress: number | null
  triggers: MaintenanceTrigger[]
  /** The trigger closest to coming due (or furthest past it). */
  leadingTrigger: MaintenanceTrigger | null
  /** Calendar due date, when a days trigger applies. */
  dueAt: Date | null
  /** The printer itself is asking for this job via an active HMS code. */
  printerRequested: boolean
  lastCompletedAt: Date | null
}

/** Fraction of an interval remaining at which a task starts reading as "due soon". */
const DUE_SOON_THRESHOLD = 0.9

const MS_PER_DAY = 24 * 60 * 60 * 1000

function resolveInterval(catalogValue: number | undefined, override: number | null | undefined): number | null {
  if (override === null) return null
  if (override !== undefined) return override > 0 ? override : null
  return catalogValue != null && catalogValue > 0 ? catalogValue : null
}

function buildTrigger(
  kind: MaintenanceTriggerKind,
  interval: number,
  elapsed: number | null,
  dueAt: Date | null
): MaintenanceTrigger {
  return {
    kind,
    interval,
    elapsed,
    progress: elapsed == null ? null : elapsed / interval,
    dueAt,
    unavailable: elapsed == null
  }
}

/**
 * Work out where a maintenance task stands.
 *
 * Due when the FIRST applicable interval elapses, so the reported `progress` is
 * the maximum across triggers rather than an average. An active HMS code forces
 * `due` outright: the printer counts its own service intervals and its counter
 * beats ours.
 *
 * A task that has never been marked done reports `not-logged` rather than
 * `due` — the printer's age is not a completion, and starting every task in a
 * red state on day one trains people to ignore the list. Marking it done once
 * starts the clock.
 */
export function evaluateMaintenanceTask(input: {
  definition: Pick<MaintenanceTaskDefinition, 'intervalDays' | 'intervalPrintHours' | 'intervalFilamentKilograms' | 'hmsCodes'>
  override?: MaintenanceTaskOverride
  completion?: MaintenanceCompletion | null
  usage: MaintenanceUsage
  /** Canonical HMS codes currently active on the printer. */
  activeHmsCodes?: readonly string[]
  now: Date
}): MaintenanceEvaluation {
  const { definition, override, completion, usage, now } = input

  const printerRequested = (definition.hmsCodes ?? []).some((code) =>
    (input.activeHmsCodes ?? []).some((active) => active.toUpperCase() === code.toUpperCase())
  )

  if (override?.disabled) {
    return {
      status: 'disabled',
      progress: null,
      triggers: [],
      leadingTrigger: null,
      dueAt: null,
      printerRequested,
      lastCompletedAt: completion?.completedAt ?? null
    }
  }

  const intervalDays = resolveInterval(definition.intervalDays, override?.intervalDays)
  const intervalPrintHours = resolveInterval(definition.intervalPrintHours, override?.intervalPrintHours)
  const intervalFilamentKilograms = resolveInterval(definition.intervalFilamentKilograms, override?.intervalFilamentKilograms)

  const triggers: MaintenanceTrigger[] = []
  if (intervalDays != null) {
    const elapsed = completion ? (now.getTime() - completion.completedAt.getTime()) / MS_PER_DAY : null
    const dueAt = completion ? new Date(completion.completedAt.getTime() + intervalDays * MS_PER_DAY) : null
    triggers.push(buildTrigger('days', intervalDays, elapsed, dueAt))
  }
  if (intervalPrintHours != null) {
    const elapsed = completion && completion.printHours != null && usage.printHours != null
      ? Math.max(0, usage.printHours - completion.printHours)
      : null
    triggers.push(buildTrigger('printHours', intervalPrintHours, elapsed, null))
  }
  if (intervalFilamentKilograms != null) {
    const elapsed = completion && completion.filamentKilograms != null && usage.filamentKilograms != null
      ? Math.max(0, usage.filamentKilograms - completion.filamentKilograms)
      : null
    triggers.push(buildTrigger('filamentKilograms', intervalFilamentKilograms, elapsed, null))
  }

  const measured = triggers.filter((trigger) => trigger.progress != null)
  const leadingTrigger = measured.length > 0
    ? measured.reduce((best, trigger) => ((trigger.progress ?? 0) > (best.progress ?? 0) ? trigger : best))
    : null
  const progress = leadingTrigger?.progress ?? null
  const dueAt = triggers.find((trigger) => trigger.kind === 'days')?.dueAt ?? null

  let status: MaintenanceStatus
  if (printerRequested) {
    status = 'due'
  } else if (!completion) {
    status = 'not-logged'
  } else if (progress == null) {
    // Every interval on this task is measured in something this printer is not
    // recording, so there is nothing honest to say beyond "you logged it once".
    status = 'ok'
  } else if (progress >= 1) {
    status = 'due'
  } else if (progress >= DUE_SOON_THRESHOLD) {
    status = 'due-soon'
  } else {
    status = 'ok'
  }

  return {
    status,
    progress,
    triggers,
    leadingTrigger,
    dueAt,
    printerRequested,
    lastCompletedAt: completion?.completedAt ?? null
  }
}

/** True for statuses that should draw the user's attention on the printers grid. */
export function isMaintenanceAttentionStatus(status: MaintenanceStatus): boolean {
  return status === 'due' || status === 'due-soon'
}
