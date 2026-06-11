/**
 * Curated public-demo print plan shared by the API seeders and the bridge
 * simulator so job identity, covers, and media stay aligned.
 */

export interface DemoPrintMediaDefinition {
  captureDirectoryName?: string
  captureStreamFileName?: string
}

export interface DemoPrintDefinition {
  fileName: string
  jobName: string
  defaultPlate: number
  media?: DemoPrintMediaDefinition
}

export interface DemoPlaylistJob {
  fileName: string
  jobName: string
  useAms: boolean
  amsMapping: number[] | null
  plate: number
  bedLevel?: boolean
}

export interface DemoPrinterPrintPlan {
  activeJob: DemoPlaylistJob | null
  recentFinishedJob: DemoPlaylistJob | null
  playlist: readonly DemoPlaylistJob[]
}

const CARD_HOLDER_PRINT: DemoPrintDefinition = {
  fileName: 'Card Holder (3 rows).gcode.3mf',
  jobName: 'Card Holder (3 rows)',
  defaultPlate: 2
}

const NUMBER_PLATES_PRINT: DemoPrintDefinition = {
  fileName: 'Number Plates.gcode.3mf',
  jobName: 'Number Plates',
  defaultPlate: 1
}

const TIRE_ROTATION_PRINT: DemoPrintDefinition = {
  fileName: 'Tire Rotation Markers.gcode.3mf',
  jobName: 'Tire Rotation Markers',
  defaultPlate: 1
}

const RAIL_MOUNT_PRINT: DemoPrintDefinition = {
  fileName: 'Rail Mount.gcode.3mf',
  jobName: 'Rail Mount',
  defaultPlate: 1,
  media: {
    captureDirectoryName: 'home-h2d-20260517-184902',
    captureStreamFileName: '20260517-184904-stream.mp4'
  }
}

export const DEMO_PRINT_DEFINITIONS: readonly DemoPrintDefinition[] = [
  CARD_HOLDER_PRINT,
  NUMBER_PLATES_PRINT,
  TIRE_ROTATION_PRINT,
  RAIL_MOUNT_PRINT
]

function makePlaylistJob(
  definition: DemoPrintDefinition,
  overrides: Partial<Omit<DemoPlaylistJob, 'fileName' | 'jobName' | 'plate'>> & { plate?: number } = {}
): DemoPlaylistJob {
  return {
    fileName: definition.fileName,
    jobName: definition.jobName,
    plate: overrides.plate ?? definition.defaultPlate,
    useAms: overrides.useAms ?? true,
    amsMapping: overrides.amsMapping ?? [0],
    bedLevel: overrides.bedLevel ?? true
  }
}

export const DEMO_PRINTER_PRINT_PLANS: Readonly<Record<string, DemoPrinterPrintPlan>> = {
  'DEMO-X1C-001': {
    activeJob: null,
    recentFinishedJob: makePlaylistJob(CARD_HOLDER_PRINT, { amsMapping: [0] }),
    playlist: [
      makePlaylistJob(CARD_HOLDER_PRINT, { amsMapping: [0] }),
      makePlaylistJob(TIRE_ROTATION_PRINT, { amsMapping: [2] }),
      makePlaylistJob(NUMBER_PLATES_PRINT, { amsMapping: [1] })
    ]
  },
  'DEMO-H2D-001': {
    activeJob: makePlaylistJob(NUMBER_PLATES_PRINT, { amsMapping: [0, 6] }),
    recentFinishedJob: makePlaylistJob(NUMBER_PLATES_PRINT, { amsMapping: [0, 6] }),
    playlist: [
      makePlaylistJob(NUMBER_PLATES_PRINT, { amsMapping: [0, 6] }),
      makePlaylistJob(RAIL_MOUNT_PRINT, { amsMapping: [2, 6] }),
      makePlaylistJob(CARD_HOLDER_PRINT, { amsMapping: [1, 4] })
    ]
  },
  'DEMO-P1S-001': {
    activeJob: makePlaylistJob(CARD_HOLDER_PRINT, { amsMapping: [0] }),
    recentFinishedJob: makePlaylistJob(CARD_HOLDER_PRINT, { amsMapping: [0] }),
    playlist: [
      makePlaylistJob(CARD_HOLDER_PRINT, { amsMapping: [0] }),
      makePlaylistJob(TIRE_ROTATION_PRINT, { amsMapping: [2] }),
      makePlaylistJob(NUMBER_PLATES_PRINT, { amsMapping: [1] })
    ]
  },
  'DEMO-X1C-002': {
    activeJob: makePlaylistJob(NUMBER_PLATES_PRINT, { amsMapping: [1] }),
    recentFinishedJob: makePlaylistJob(CARD_HOLDER_PRINT, { amsMapping: [0] }),
    playlist: [
      makePlaylistJob(CARD_HOLDER_PRINT, { amsMapping: [0] }),
      makePlaylistJob(NUMBER_PLATES_PRINT, { amsMapping: [1] }),
      makePlaylistJob(TIRE_ROTATION_PRINT, { amsMapping: [2] })
    ]
  },
  'DEMO-H2D-002': {
    activeJob: makePlaylistJob(RAIL_MOUNT_PRINT, { amsMapping: [2, 6] }),
    recentFinishedJob: makePlaylistJob(NUMBER_PLATES_PRINT, { amsMapping: [1, 7] }),
    playlist: [
      makePlaylistJob(RAIL_MOUNT_PRINT, { amsMapping: [2, 6] }),
      makePlaylistJob(NUMBER_PLATES_PRINT, { amsMapping: [1, 7] }),
      makePlaylistJob(CARD_HOLDER_PRINT, { amsMapping: [2, 4] })
    ]
  },
  'DEMO-P1S-002': {
    activeJob: makePlaylistJob(TIRE_ROTATION_PRINT, { amsMapping: [2] }),
    recentFinishedJob: makePlaylistJob(TIRE_ROTATION_PRINT, { amsMapping: [2] }),
    playlist: [
      makePlaylistJob(TIRE_ROTATION_PRINT, { amsMapping: [2] }),
      makePlaylistJob(CARD_HOLDER_PRINT, { amsMapping: [0] }),
      makePlaylistJob(NUMBER_PLATES_PRINT, { amsMapping: [1] })
    ]
  }
}

export const DEMO_LIBRARY_TARGETS = Array.from(new Set(
  DEMO_PRINT_DEFINITIONS.map((definition) => definition.fileName)
))

export function findDemoPrintDefinitionByFileName(fileName: string | null | undefined): DemoPrintDefinition | null {
  if (!fileName) return null
  const normalized = normalizeDemoPrintFileName(fileName)
  return DEMO_PRINT_DEFINITIONS.find((definition) => normalizeDemoPrintFileName(definition.fileName) === normalized) ?? null
}

export function findDemoPrintDefinitionByJobName(jobName: string | null | undefined): DemoPrintDefinition | null {
  if (!jobName) return null
  return DEMO_PRINT_DEFINITIONS.find((definition) => definition.jobName === jobName) ?? null
}

export function getDemoPrinterPrintPlan(printerSerial: string): DemoPrinterPrintPlan | null {
  return DEMO_PRINTER_PRINT_PLANS[printerSerial] ?? null
}

export function getDemoPrinterActiveJob(printerSerial: string): DemoPlaylistJob | null {
  return getDemoPrinterPrintPlan(printerSerial)?.activeJob ?? null
}

export function getDemoPrinterRecentFinishedJob(printerSerial: string): DemoPlaylistJob | null {
  return getDemoPrinterPrintPlan(printerSerial)?.recentFinishedJob ?? null
}

export function getDemoPrinterPlaylist(printerSerial: string): readonly DemoPlaylistJob[] {
  return getDemoPrinterPrintPlan(printerSerial)?.playlist ?? []
}

export function findDemoPlaylistJob(printerSerial: string, jobName: string): DemoPlaylistJob | null {
  return getDemoPrinterPlaylist(printerSerial).find((job) => job.jobName === jobName) ?? null
}

export function getNextDemoPlaylistJob(printerSerial: string, lastJobName: string | null | undefined): DemoPlaylistJob | null {
  const playlist = getDemoPrinterPlaylist(printerSerial)
  if (playlist.length === 0) return null
  if (!lastJobName) return playlist[0] ?? null

  const index = playlist.findIndex((job) => job.jobName === lastJobName)
  if (index < 0) return playlist[0] ?? null
  return playlist[(index + 1) % playlist.length] ?? null
}

export function normalizeDemoPrintFileName(fileName: string): string {
  const basename = fileName.split(/[\\/]/).pop() ?? fileName
  return basename.replace(/^[^-]+-/, '')
}