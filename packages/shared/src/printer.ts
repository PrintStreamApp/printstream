/**
 * Printer-domain contracts shared between the API and web client.
 *
 * Bambu printers expose state via MQTT. The API normalizes that into a
 * stable, web-friendly snapshot defined here so the UI never has to know
 * about the raw MQTT payload shape.
 *
 * This module is a thin barrel over four focused layers (each re-exported
 * verbatim, so importers keep using `./printer.js` unchanged):
 * - `./printer-contracts.js`: the wire/DTO Zod schemas and inferred types.
 * - `./printer-capabilities.js`: model -> capability tables and helpers.
 * - `./printer-error-state.js`: fault vs. cancelled-print classification.
 * - `./printer-actions.js`: action-availability logic and reason strings.
 *
 * Dependencies flow one way: contracts <- capabilities <- error-state <- actions.
 */
export * from './printer-contracts.js'
export * from './printer-capabilities.js'
export * from './printer-error-state.js'
export * from './printer-actions.js'
