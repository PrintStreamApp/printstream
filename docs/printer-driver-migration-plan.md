# Printer Driver Migration Plan

## Goal

Support additional printer vendors in the future without rewriting the web app, plugin system, or job history model.

## Non-goals

- Do not implement multi-vendor support now.
- Do not destabilize the current Bambu path while auth and current bug work are still active.
- Do not force the web UI to understand vendor transport details.

## Current State

The current architecture has one strong reusable seam and three strong Bambu couplings.

Reusable seam:

- The web app consumes normalized status and typed WS events rather than raw transport payloads.
- Plugins subscribe to normalized printer lifecycle events instead of MQTT directly.

Main couplings:

- Shared printer contracts are Bambu-shaped: model enum, AMS, external spools, virtual trays, Bambu nozzle and pressure-advance concepts.
- API transport is Bambu-shaped: MQTT manager, FTPS storage, `project_file` start flow, Bambu command names.
- Persistence is Bambu-shaped: saved printer config assumes `host + serial + accessCode` instead of a driver-selected connection config.

That means future support is feasible, but only after introducing a real driver boundary.

## Target End State

The system should move to this layering:

1. Core shared printer contract for generic state and generic actions.
2. Driver capability surface that tells the web what a printer supports.
3. Vendor driver implementations for Bambu and future vendors.
4. Optional vendor-specific details kept behind explicit extension objects instead of being embedded in the universal contract.

## Core Types To Introduce

### Shared vendor identity

Add a vendor field to the persisted printer and shared DTOs.

```ts
export const printerVendorSchema = z.enum(['bambu'])
export type PrinterVendor = z.infer<typeof printerVendorSchema>
```

This stays small at first. New vendors are added only when a real driver exists.

### Generic printer record

The saved printer shape needs a split between core identity and driver config.

```ts
interface PrinterRecordCore {
  id: string
  name: string
  vendor: PrinterVendor
  model: string
  position: number
  createdAt: string
  updatedAt: string
}

interface BambuPrinterConfig {
  host: string
  serial: string
  accessCode: string
}
```

Do not jump straight to a polymorphic Prisma schema rewrite. The first step can keep current Bambu columns and add `vendor` with default `bambu`.

### Generic driver capability contract

The UI needs capability-driven rendering instead of model-family assumptions.

```ts
interface PrinterDriverCapabilities {
  connection: {
    liveStatus: boolean
    commandTransport: boolean
    storageBrowse: boolean
    cameraSnapshot: boolean
    cameraStream: boolean
    discovery: boolean
  }
  motion: {
    home: boolean
    jog: boolean
  }
  temperatures: {
    nozzle: boolean
    bed: boolean
    chamber: boolean
  }
  fans: {
    part: boolean
    aux: boolean
    chamber: boolean
  }
  filament: {
    ams: boolean
    externalSpool: boolean
    loadUnload: boolean
  }
  print: {
    start: boolean
    pause: boolean
    resume: boolean
    stop: boolean
    speed: boolean
  }
  calibration: {
    supported: boolean
    nozzleOffset: boolean
    vibration: boolean
    bedLeveling: boolean
  }
}
```

### Generic status contract

Keep one normalized status object for the UI, but split core from vendor extensions.

```ts
interface PrinterStatusCore {
  printerId: string
  online: boolean
  stage: 'idle' | 'preparing' | 'heating' | 'printing' | 'paused' | 'finished' | 'failed' | 'unknown'
  subStage: string | null
  progressPercent: number | null
  currentLayer: number | null
  totalLayers: number | null
  remainingMinutes: number | null
  jobName: string | null
  firmwareVersion: string | null
  observedAt: string

  toolheads: Array<{
    toolheadId: string
    nozzleTemp: number | null
    nozzleTarget: number | null
  }>

  bedTemp: number | null
  bedTarget: number | null
  chamberTemp: number | null

  fans: {
    part: number | null
    aux: number | null
    chamber: number | null
  }

  lights: Record<string, 'on' | 'off' | 'flashing' | 'unknown' | null>
  capabilities: PrinterDriverCapabilities
}

interface PrinterStatus {
  core: PrinterStatusCore
  vendorDetails?: {
    bambu?: BambuStatusDetails
  }
}
```

This is the biggest contract change, so it should not be done first.

### Driver interface in the API

Add a server-side driver boundary that owns transport and vendor translation.

```ts
interface PrinterDriver {
  readonly vendor: PrinterVendor

  connect(printer: Printer): Promise<void>
  disconnect(printerId: string): Promise<void>

  getCapabilities(printer: Printer): PrinterDriverCapabilities
  getStatus(printerId: string): PrinterStatus | null

  sendCommand(printer: Printer, command: PrinterCommand): Promise<void>

  startPrint(input: DriverPrintStartInput): Promise<DriverPrintStartResult>

  listStorage?(printer: Printer, path: string): Promise<PrinterFsEntry[]>
  readStorageFile?(printer: Printer, path: string): Promise<Readable>
  uploadStorageFile?(printer: Printer, localPath: string, remotePath: string): Promise<void>

  getSnapshot?(printer: Printer): Promise<Buffer>
  openStream?(printer: Printer): Promise<DriverCameraStream>

  validateConnection?(input: unknown): Promise<PrinterConnectionValidation>
  discover?(): Promise<DiscoveredPrinter[]>
}
```

## Recommended Migration Sequence

### Phase 1: Add vendor identity without behavior change

Purpose: make the schema multi-driver-ready while keeping the entire runtime on Bambu.

Steps:

1. Add `vendor` to Prisma `Printer` with default `bambu`.
2. Add `printerVendorSchema` and include it in shared `Printer` DTOs.
3. Keep existing `host`, `serial`, and `accessCode` columns unchanged.
4. Keep every current route and runtime path working exactly as it does today.

Deliverable:

- No behavior change.
- Every persisted printer is explicitly tagged as Bambu.

### Phase 2: Introduce API driver interfaces behind the existing Bambu implementation

Purpose: turn today’s implicit Bambu runtime into an explicit Bambu driver.

Steps:

1. Create `apps/api/src/printer-driver/types.ts`.
2. Create a `PrinterDriverRegistry` that resolves a driver by `printer.vendor`.
3. Move current Bambu-only logic behind a `BambuPrinterDriver` implementation.
4. Keep the driver interface thin at first:
   - `connect`
   - `disconnect`
   - `getStatus`
   - `sendCommand`

Initial rule:

- Do not rewrite the parser first.
- Wrap current modules first, then extract internals once the seam is proven.

Deliverable:

- Existing routes call a driver abstraction, even though only the Bambu driver exists.

### Phase 3: Split transport-specific services out of the monolithic Bambu path

Purpose: isolate the hardest Bambu-only subsystems.

Services to carve out:

1. `BambuStatusTransport`
   - MQTT connect/reconnect
   - report parsing
   - command publication

2. `BambuStorageTransport`
   - FTPS browse/download/upload

3. `BambuCameraTransport`
   - snapshot and stream handling

4. `BambuPrintStarter`
   - `project_file`
   - `ams_mapping`
   - plate-specific start payloads

Deliverable:

- Bambu support still works.
- Future drivers can replace storage, camera, and print-start independently.

### Phase 4: Move route command translation into drivers

Purpose: stop encoding Bambu command names in generic routes.

Current problem:

- `apps/api/src/routes/printers.ts` translates user actions directly into Bambu payloads.

Refactor target:

```ts
await driver.sendCommand(printer, parsedCommand)
```

Inside the Bambu driver:

- `set_nozzle_temp`
- `set_bed_temp`
- `set_fan`
- `clean_print_error`
- `ams_user_setting`
- fallback gcode selection
- all report-driven protocol routing

Deliverable:

- Routes become generic request validation plus authorization.
- Driver owns vendor command selection.

### Phase 5: Split shared contracts into generic core and vendor extensions

Purpose: make the web capable of rendering non-Bambu printers without pretending every vendor has AMS and virtual trays.

Steps:

1. Define a generic `PrinterStatusCore`.
2. Move Bambu-only status to `vendorDetails.bambu`.
3. Define generic control capabilities separate from model helpers.
4. Keep temporary compatibility adapters so the current web can migrate incrementally.

Rule:

- Do not do this before the API driver boundary exists.
- Otherwise the contract split will happen while the runtime is still Bambu-hardcoded, which will create churn without reducing coupling.

Deliverable:

- The UI can render a generic printer card from core fields.
- Bambu-specific panels only mount when Bambu details exist.

### Phase 6: Make dispatch brand-aware

Purpose: stop assuming every printer starts jobs through Bambu FTPS + `project_file`.

Refactor target:

```ts
await driver.startPrint({
  printer,
  artifact,
  options,
})
```

Driver-owned concerns:

- upload or remote transfer
- file-path conventions
- print-start command format
- material mapping semantics
- plate-selection semantics

Core-owned concerns:

- queueing
- cancellation state
- retry bookkeeping
- plugin print guards
- job history metadata

Deliverable:

- Dispatch becomes reusable orchestration.
- Vendor-specific start semantics move into drivers.

### Phase 7: Make discovery and connection validation driver-owned

Purpose: allow some vendors to be manual-only and others to support broadcast discovery.

Refactor target:

- `validatePrinterLanConnection` becomes `driver.validateConnection(...)`
- SSDP and Bambu LAN discovery become `BambuDiscoveryProvider`

Deliverable:

- Add Printer flow becomes vendor-aware without branching through the whole route layer.

## First Safe Refactor Slice

If work starts later, this should be the first actual implementation slice.

1. Add Prisma `Printer.vendor` defaulting to `bambu`.
2. Add shared `printerVendorSchema`.
3. Create:
   - `apps/api/src/printer-driver/types.ts`
   - `apps/api/src/printer-driver/registry.ts`
   - `apps/api/src/printer-driver/bambu-driver.ts`
4. Make current `printerManager` an internal dependency of the Bambu driver instead of a universal singleton the routes talk to directly.
5. Update routes to resolve the driver by printer vendor before sending commands.

Why this slice first:

- It reduces coupling without forcing a UI contract rewrite.
- It keeps the Bambu path stable.
- It creates the seam every later phase depends on.

## Explicit Deferred Items

These should wait until the driver boundary exists:

- Replacing `printerModelSchema` with a vendor-neutral model system.
- Reworking AMS and external-spool shapes.
- Redesigning the printer dashboard around generic toolheads and consumables.
- Refactoring camera routes into generic driver-owned endpoints.
- Introducing a second vendor implementation.

## Risks

1. Shared contract churn is the highest-risk area because the web and API both depend on it.
2. Dispatch is the second highest-risk area because it currently assumes Bambu file-transfer and start semantics.
3. Trying to genericize AMS too early will create abstraction debt because AMS is not a generic multi-vendor concept.
4. Leaving command translation in routes while adding vendors will produce combinatorial branching and should be avoided.

## Rule For Later Work

When this work resumes, the rule should be:

- First isolate Bambu behind a driver.
- Then split core versus vendor-specific contracts.
- Only then add a second vendor.

Doing those out of order will create a large refactor with poor rollback points.