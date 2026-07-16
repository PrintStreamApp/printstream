/**
 * Shared type aliases extracted from `pages/PrintersView.tsx`.
 *
 * Owns the printers-dashboard module-level types that carry no component
 * coupling: the controls-dialog tab union, the filament-recovery load
 * command/source shapes, and the printer-settings command narrowing. Types
 * derived from a sub-component's props stay with that component; keep only
 * standalone, shared shapes here.
 */
import { type PrinterCommand } from '@printstream/shared'

export type PrinterControlsDialogTab = 'printer' | 'speed' | 'temperature' | 'nozzles' | 'fans' | 'motion' | 'extruder'

export type PrinterRecoveryLoadCommand =
  | Extract<PrinterCommand, { type: 'loadAmsFilament' }>
  | Extract<PrinterCommand, { type: 'loadExternalSpool' }>

export type PrinterRecoveryFilamentSource = {
  key: string
  label: string
  detail: string
  command: PrinterRecoveryLoadCommand
}

export type PrinterSettingsDialogCommand = Extract<PrinterCommand, { type: 'setPrintOption' | 'setAirductMode' }>
