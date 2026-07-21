process.env.NODE_ENV = 'test'

import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import express from 'express'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { PrintDispatchJob } from '@printstream/shared'
import type { RequestAuthContext } from '../../lib/auth-context.js'
import { HttpError } from '../../lib/http-error.js'
import { PrinterEventBus } from '../../lib/printer-events.js'
import { prisma } from '../../lib/prisma.js'
import { installTenantContext } from '../../lib/tenant-context.js'
import { createOrdersPlugin } from './index.js'

const testRoot = mkdtempSync(path.join(tmpdir(), 'bambu-orders-plugin-test-'))

after(async () => {
  await rm(testRoot, { recursive: true, force: true })
})

test('orders routes create templates, expand order prints, and complete the order across confirm and manual completion', async () => {
  const state = createOrdersState()
  const plugin = createOrdersPlugin({
    enqueueLibraryPrint: async (input): Promise<PrintDispatchJob> => ({
      id: 'dispatch-1',
      printJobId: 'dispatch-1',
      printerId: input.printerId,
      printerName: 'Printer 1',
      fileId: input.fileId,
      fileName: 'widget.gcode',
      jobName: 'widget.gcode',
      fileSizeBytes: 128,
      sourceKind: 'gcode',
      projectFilamentChips: [],
      plate: input.plate,
      plateName: null,
      useAms: input.useAms,
      bedLevel: input.bedLevel,
      amsMapping: input.amsMapping ?? null,
      status: 'queued',
      progressMessage: 'Waiting to upload',
      uploadAttempt: 0,
      uploadMaxAttempts: 3,
      uploadBytesSent: 0,
      uploadTotalBytes: null,
      uploadPercent: null,
      error: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelRequested: false
    }),
    inspectBridgeLibraryThreeMf: async () => ({ plates: [], projectFilaments: [], compatiblePrinterModels: [], supportFilamentIds: [], printerProfileName: null, processProfileName: null, geometryOnly: false, objectExport: false, needsSettingsRepair: false, projectVersion: null }),
    resolveLibraryFileToLocalPath: async (file) => path.join(testRoot, file.storedPath),
    readPlateIndex: async () => ({ plates: [] }) as never
  })

  await withRegisteredPluginApp({ plugin, prisma: createPrismaStub(state) }, async ({ baseUrl }) => {
    const templateResponse = await fetch(`${baseUrl}/api/plugins/orders/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Widget batch',
        code: 'W-100',
        variants: [{
          name: 'Standard',
          items: [{ libraryFileId: 'file-1', plate: 1, quantity: 2 }]
        }]
      })
    })

    assert.equal(templateResponse.status, 201)
    const templateBody = await templateResponse.json() as {
      template: { id: string }
    }

    const createOrderResponse = await fetch(`${baseUrl}/api/plugins/orders/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: templateBody.template.id,
        name: 'Batch A'
      })
    })

    assert.equal(createOrderResponse.status, 201)
    const createOrderBody = await createOrderResponse.json() as {
      order: {
        id: string
        status: string
        prints: Array<{ id: string; status: string; activityState: string; attemptCount: number }>
      }
    }
    assert.equal(createOrderBody.order.prints.length, 2)
    assert.deepEqual(
      createOrderBody.order.prints.map((print) => ({ status: print.status, activityState: print.activityState, attemptCount: print.attemptCount })),
      [
        { status: 'pending', activityState: 'pending', attemptCount: 0 },
        { status: 'pending', activityState: 'pending', attemptCount: 0 }
      ]
    )

    const firstPrintId = createOrderBody.order.prints[0]?.id
    const secondPrintId = createOrderBody.order.prints[1]?.id
    assert.ok(firstPrintId)
    assert.ok(secondPrintId)

    const startResponse = await fetch(`${baseUrl}/api/plugins/orders/orders/${createOrderBody.order.id}/prints/${firstPrintId}/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ printerId: 'printer-1' })
    })

    assert.equal(startResponse.status, 202)
    const startBody = await startResponse.json() as {
      order: { prints: Array<{ id: string; status: string; activityState: string; attemptCount: number }> }
    }
    const startedPrint = startBody.order.prints.find((print) => print.id === firstPrintId)
    assert.equal(startedPrint?.status, 'started')
    assert.equal(startedPrint?.activityState, 'queued')
    assert.equal(startedPrint?.attemptCount, 1)

    const persistedStartedPrint = state.orderPrints.find((print) => print.id === firstPrintId)
    assert.ok(persistedStartedPrint?.startedAt)
    state.printJobs.push({
      id: 'job-1',
      printerId: 'printer-1',
      fileName: 'widget.gcode',
      plate: 1,
      startedAt: persistedStartedPrint.startedAt,
      finishedAt: new Date(persistedStartedPrint.startedAt.getTime() + 60_000),
      result: 'success'
    })

    const confirmResponse = await fetch(`${baseUrl}/api/plugins/orders/orders/${createOrderBody.order.id}/prints/${firstPrintId}/confirm`, {
      method: 'POST'
    })

    assert.equal(confirmResponse.status, 200)
    const confirmBody = await confirmResponse.json() as {
      order: {
        status: string
        progress: { completed: number; total: number }
        prints: Array<{ id: string; status: string; completionSource: string | null; activityState: string }>
      }
    }
    const confirmedPrint = confirmBody.order.prints.find((print) => print.id === firstPrintId)
    assert.equal(confirmedPrint?.status, 'completed')
    assert.equal(confirmedPrint?.completionSource, 'confirmed')
    assert.equal(confirmedPrint?.activityState, 'completed')
    assert.equal(confirmBody.order.status, 'active')
    assert.equal(confirmBody.order.progress.completed, 1)
    assert.equal(confirmBody.order.progress.total, 2)

    const manualCompleteResponse = await fetch(`${baseUrl}/api/plugins/orders/orders/${createOrderBody.order.id}/prints/${secondPrintId}/manual-complete`, {
      method: 'POST'
    })

    assert.equal(manualCompleteResponse.status, 200)
    const manualCompleteBody = await manualCompleteResponse.json() as {
      order: {
        status: string
        completedAt: string | null
        progress: { completed: number; total: number }
        prints: Array<{ id: string; status: string; completionSource: string | null; activityState: string }>
      }
    }
    const manuallyCompletedPrint = manualCompleteBody.order.prints.find((print) => print.id === secondPrintId)
    assert.equal(manuallyCompletedPrint?.status, 'completed')
    assert.equal(manuallyCompletedPrint?.completionSource, 'manual')
    assert.equal(manuallyCompletedPrint?.activityState, 'completed')
    assert.equal(manualCompleteBody.order.status, 'completed')
    assert.ok(manualCompleteBody.order.completedAt)
    assert.equal(manualCompleteBody.order.progress.completed, 2)
    assert.equal(manualCompleteBody.order.progress.total, 2)
  })
})

test('orders create only the selected template variants and multiplies their required prints by quantity', async () => {
  const state = createOrdersState()
  const plugin = createOrdersPlugin({
    enqueueLibraryPrint: async () => {
      throw new Error('not used in variant selection test')
    },
    inspectBridgeLibraryThreeMf: async () => ({ plates: [], projectFilaments: [], compatiblePrinterModels: [], supportFilamentIds: [], printerProfileName: null, processProfileName: null, geometryOnly: false, objectExport: false, needsSettingsRepair: false, projectVersion: null }),
    resolveLibraryFileToLocalPath: async (file) => path.join(testRoot, file.storedPath),
    readPlateIndex: async () => ({ plates: [] }) as never
  })

  await withRegisteredPluginApp({ plugin, prisma: createPrismaStub(state) }, async ({ baseUrl }) => {
    const templateResponse = await fetch(`${baseUrl}/api/plugins/orders/templates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Widget family',
        variants: [
          {
            name: 'Small',
            items: [{ libraryFileId: 'file-1', plate: 1, quantity: 1 }]
          },
          {
            name: 'Large',
            items: [{ libraryFileId: 'file-1', plate: 1, quantity: 2 }]
          }
        ]
      })
    })

    assert.equal(templateResponse.status, 201)
    const templateBody = await templateResponse.json() as {
      template: {
        id: string
        variants: Array<{
          id: string
          name: string
          items: Array<{ id: string }>
        }>
      }
    }

    const smallVariant = templateBody.template.variants.find((variant) => variant.name === 'Small')
    const smallVariantId = smallVariant?.id
    const smallVariantPrintId = smallVariant?.items[0]?.id
    const largeVariant = templateBody.template.variants.find((variant) => variant.name === 'Large')
    const largeVariantId = largeVariant?.id
    const largeVariantPrintId = largeVariant?.items[0]?.id
    assert.ok(smallVariantId)
    assert.ok(smallVariantPrintId)
    assert.ok(largeVariantId)
    assert.ok(largeVariantPrintId)

    const createOrderResponse = await fetch(`${baseUrl}/api/plugins/orders/orders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        templateId: templateBody.template.id,
        name: 'Variant batch',
        printFilamentOverrides: [
          {
            templatePrintId: largeVariantPrintId,
            variantCopyIndex: 0,
            projectFilaments: [{
              id: 1,
              filamentType: 'PETG Basic',
              filamentName: 'PETG Basic',
              color: '#1F5FBF',
              nozzleId: null,
              chamberTemperature: null
            }]
          },
          {
            templatePrintId: smallVariantPrintId,
            variantCopyIndex: 0,
            projectFilaments: [{
              id: 1,
              filamentType: 'PLA Basic',
              filamentName: 'PLA Basic',
              color: '#00AE42',
              nozzleId: null,
              chamberTemperature: null
            }]
          },
          {
            templatePrintId: smallVariantPrintId,
            variantCopyIndex: 1,
            projectFilaments: [{
              id: 1,
              filamentType: 'PLA Basic',
              filamentName: 'PLA Basic',
              color: '#FF6A13',
              nozzleId: null,
              chamberTemperature: null
            }]
          }
        ],
        variants: [
          { variantId: smallVariantId, quantity: 2 },
          { variantId: largeVariantId, quantity: 1 }
        ]
      })
    })

    assert.equal(createOrderResponse.status, 201)
    const createOrderBody = await createOrderResponse.json() as {
      order: {
        selectedVariants: Array<{ templateVariantName: string; quantity: number }>
        prints: Array<{
          templateVariantName: string | null
          sequenceCount: number
          projectFilamentOverrides: Array<{ filamentType: string | null; color: string | null }> | null
        }>
      }
    }

    assert.deepEqual(
      createOrderBody.order.selectedVariants.map((variant) => ({
        templateVariantName: variant.templateVariantName,
        quantity: variant.quantity
      })),
      [
        { templateVariantName: 'Small', quantity: 2 },
        { templateVariantName: 'Large', quantity: 1 }
      ]
    )
    assert.equal(createOrderBody.order.prints.length, 4)
    assert.deepEqual(
      createOrderBody.order.prints.map((print) => ({
        templateVariantName: print.templateVariantName,
        sequenceCount: print.sequenceCount
      })),
      [
        { templateVariantName: 'Small', sequenceCount: 1 },
        { templateVariantName: 'Small', sequenceCount: 1 },
        { templateVariantName: 'Large', sequenceCount: 2 },
        { templateVariantName: 'Large', sequenceCount: 2 }
      ]
    )
    assert.deepEqual(
      createOrderBody.order.prints.map((print) => print.projectFilamentOverrides?.[0]?.filamentType ?? null),
      ['PLA Basic', 'PLA Basic', 'PETG Basic', 'PETG Basic']
    )
    assert.deepEqual(
      state.orderPrints.map((print) => print.projectFilamentOverrides?.[0]?.color ?? null),
      ['#00AE42', '#FF6A13', '#1F5FBF', '#1F5FBF']
    )
  })
})

test('orders confirmation rejects prints that have not finished successfully yet', async () => {
  const state = createOrdersState({
    orders: [{
      id: 'order-1',
      templateId: 'template-1',
      templateName: 'Widget batch',
      templateCode: null,
      templateDescription: null,
      name: 'Batch A',
      notes: null,
      status: 'active',
      completedAt: null,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
      updatedAt: new Date('2026-04-29T12:00:00.000Z')
    }],
    orderPrints: [{
      id: 'order-print-1',
      orderId: 'order-1',
      templatePrintId: null,
      libraryFileId: 'file-1',
      libraryFileName: 'widget.gcode',
      plate: 1,
      notes: null,
      groupPosition: 0,
      sequenceNumber: 1,
      sequenceCount: 1,
      status: 'started',
      completionSource: null,
      attemptCount: 1,
      startedPrinterId: 'printer-1',
      startedAt: new Date('2026-04-29T12:05:00.000Z'),
      lastPrintJobId: null,
      lastPrintResult: null,
      lastPrintFinishedAt: null,
      completedAt: null,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
      updatedAt: new Date('2026-04-29T12:05:00.000Z')
    }]
  })

  await withRegisteredPluginApp({
    plugin: createOrdersPlugin(),
    prisma: createPrismaStub(state)
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/orders/orders/order-1/prints/order-print-1/confirm`, {
      method: 'POST'
    })

    assert.equal(response.status, 409)
    const body = await response.json() as { error: string }
    assert.match(body.error, /queued but has not started/i)
  })
})

test('orders can update name and notes', async () => {
  const state = createOrdersState({
    orders: [{
      id: 'order-1',
      templateId: 'template-1',
      templateName: 'Widget batch',
      templateCode: null,
      templateDescription: null,
      name: 'Batch A',
      notes: 'old notes',
      status: 'active',
      completedAt: null,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
      updatedAt: new Date('2026-04-29T12:00:00.000Z')
    }]
  })

  await withRegisteredPluginApp({
    plugin: createOrdersPlugin(),
    prisma: createPrismaStub(state)
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/orders/orders/order-1`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Batch A Revised',
        notes: 'new notes'
      })
    })

    assert.equal(response.status, 200)
    const body = await response.json() as {
      order: {
        name: string
        notes: string | null
      }
    }
    assert.equal(body.order.name, 'Batch A Revised')
    assert.equal(body.order.notes, 'new notes')
    assert.equal(state.orders[0]?.name, 'Batch A Revised')
    assert.equal(state.orders[0]?.notes, 'new notes')
  })
})

test('orders can be deleted', async () => {
  const state = createOrdersState({
    orders: [{
      id: 'order-1',
      templateId: 'template-1',
      templateName: 'Widget batch',
      templateCode: null,
      templateDescription: null,
      name: 'Batch A',
      notes: null,
      status: 'active',
      completedAt: null,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
      updatedAt: new Date('2026-04-29T12:00:00.000Z')
    }],
    orderPrints: [{
      id: 'order-print-1',
      orderId: 'order-1',
      templatePrintId: null,
      libraryFileId: 'file-1',
      libraryFileName: 'widget.gcode',
      plate: 1,
      notes: null,
      groupPosition: 0,
      sequenceNumber: 1,
      sequenceCount: 1,
      status: 'pending',
      completionSource: null,
      attemptCount: 0,
      startedPrinterId: null,
      startedAt: null,
      lastPrintJobId: null,
      lastPrintResult: null,
      lastPrintFinishedAt: null,
      completedAt: null,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
      updatedAt: new Date('2026-04-29T12:00:00.000Z')
    }]
  })

  await withRegisteredPluginApp({
    plugin: createOrdersPlugin(),
    prisma: createPrismaStub(state)
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/orders/orders/order-1`, {
      method: 'DELETE'
    })

    assert.equal(response.status, 204)
    assert.equal(state.orders.length, 0)
    assert.equal(state.orderPrints.length, 0)
  })
})

test('completed order prints can be reopened back to pending', async () => {
  const completedAt = new Date('2026-04-29T12:10:00.000Z')
  const state = createOrdersState({
    orders: [{
      id: 'order-1',
      templateId: 'template-1',
      templateName: 'Widget batch',
      templateCode: null,
      templateDescription: null,
      name: 'Batch A',
      notes: null,
      status: 'completed',
      completedAt,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
      updatedAt: completedAt
    }],
    orderPrints: [{
      id: 'order-print-1',
      orderId: 'order-1',
      templatePrintId: null,
      libraryFileId: 'file-1',
      libraryFileName: 'widget.gcode',
      plate: 1,
      notes: null,
      groupPosition: 0,
      sequenceNumber: 1,
      sequenceCount: 1,
      status: 'completed',
      completionSource: 'manual',
      attemptCount: 1,
      startedPrinterId: null,
      startedAt: null,
      lastPrintJobId: 'job-1',
      lastPrintResult: 'success',
      lastPrintFinishedAt: completedAt,
      completedAt,
      createdAt: new Date('2026-04-29T12:00:00.000Z'),
      updatedAt: completedAt
    }]
  })

  await withRegisteredPluginApp({
    plugin: createOrdersPlugin(),
    prisma: createPrismaStub(state)
  }, async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/plugins/orders/orders/order-1/prints/order-print-1/reopen`, {
      method: 'POST'
    })

    assert.equal(response.status, 200)
    const body = await response.json() as {
      order: {
        status: string
        completedAt: string | null
        progress: { completed: number; pending: number }
        prints: Array<{
          id: string
          status: string
          activityState: string
          completionSource: string | null
          lastPrintJobId: string | null
          lastPrintResult: string | null
        }>
      }
    }

    assert.equal(body.order.status, 'active')
    assert.equal(body.order.completedAt, null)
    assert.equal(body.order.progress.completed, 0)
    assert.equal(body.order.progress.pending, 1)

    const reopenedPrint = body.order.prints.find((print) => print.id === 'order-print-1')
    assert.equal(reopenedPrint?.status, 'pending')
    assert.equal(reopenedPrint?.activityState, 'pending')
    assert.equal(reopenedPrint?.completionSource, null)
    assert.equal(reopenedPrint?.lastPrintJobId, null)
    assert.equal(reopenedPrint?.lastPrintResult, null)

    assert.equal(state.orders[0]?.status, 'active')
    assert.equal(state.orders[0]?.completedAt, null)
    assert.equal(state.orderPrints[0]?.status, 'pending')
    assert.equal(state.orderPrints[0]?.completionSource, null)
    assert.equal(state.orderPrints[0]?.lastPrintJobId, null)
    assert.equal(state.orderPrints[0]?.lastPrintResult, null)
  })
})

type OrdersState = {
  nextId: number
  printers: Array<{ id: string; name: string }>
  libraryFiles: Array<{
    id: string
    name: string
    storedPath: string
    sizeBytes: number
    kind: string
    thumbnailPath: string | null
    uploadedAt: Date
    folderId: string | null
    snapshotKey: string | null
    hidden: boolean
  }>
  orderTemplates: Array<{
    id: string
    name: string
    code: string | null
    description: string | null
    notesTemplate: string | null
    createdAt: Date
    updatedAt: Date
  }>
  orderTemplateVariants: Array<{
    id: string
    templateId: string
    name: string
    position: number
    createdAt: Date
    updatedAt: Date
  }>
  orderTemplatePrints: Array<{
    id: string
    templateVariantId?: string
    libraryFileId: string | null
    libraryFileName: string
    plate: number
    quantity: number
    notes: string | null
    position: number
  }>
  orders: Array<{
    id: string
    templateId: string | null
    templateName: string
    templateCode: string | null
    templateDescription: string | null
    name: string
    notes: string | null
    status: string
    completedAt: Date | null
    createdAt: Date
    updatedAt: Date
  }>
  orderVariantSelections: Array<{
    id: string
    orderId: string
    templateVariantId: string | null
    templateVariantName: string
    quantity: number
    position: number
    createdAt: Date
    updatedAt: Date
  }>
  orderPrints: Array<{
    id: string
    orderId: string
    templatePrintId: string | null
    templateVariantId?: string | null
    templateVariantName?: string | null
    projectFilamentOverrides?: Array<{
      id: number
      filamentType: string | null
      filamentName: string | null
      color: string | null
      nozzleId: number | null
      chamberTemperature: number | null
    }> | null
    libraryFileId: string | null
    libraryFileName: string
    plate: number
    notes: string | null
    groupPosition: number
    sequenceNumber: number
    sequenceCount: number
    status: string
    completionSource: string | null
    attemptCount: number
    startedPrinterId: string | null
    startedAt: Date | null
    lastPrintJobId: string | null
    lastPrintResult: string | null
    lastPrintFinishedAt: Date | null
    completedAt: Date | null
    createdAt: Date
    updatedAt: Date
  }>
  printJobs: Array<{
    id: string
    printerId: string
    fileName: string
    plate: number | null
    startedAt: Date
    finishedAt: Date | null
    result: string
  }>
}

function createOrdersState(overrides: Partial<OrdersState> = {}): OrdersState {
  return {
    nextId: 1,
    printers: [{ id: 'printer-1', name: 'Printer 1' }],
    libraryFiles: [{
      id: 'file-1',
      name: 'widget.gcode',
      storedPath: 'widget.gcode',
      sizeBytes: 128,
      kind: 'gcode',
      thumbnailPath: null,
      uploadedAt: new Date('2026-04-29T12:00:00.000Z'),
      folderId: null,
      snapshotKey: null,
      hidden: false
    }],
    orderTemplates: [],
    orderTemplateVariants: [],
    orderTemplatePrints: [],
    orders: [],
    orderVariantSelections: [],
    orderPrints: [],
    printJobs: [],
    ...overrides
  }
}

function createPrismaStub(state: OrdersState) {
  const now = () => new Date(`2026-04-29T12:00:${String(state.nextId).padStart(2, '0')}.000Z`)
  const nextId = (prefix: string) => `${prefix}-${state.nextId++}`

  const withTemplateRelations = (template: OrdersState['orderTemplates'][number]) => ({
    ...template,
    variants: state.orderTemplateVariants
      .filter((variant) => variant.templateId === template.id)
      .sort((left, right) => left.position - right.position)
      .map((variant) => ({
        ...variant,
        items: state.orderTemplatePrints
          .filter((item) => item.templateVariantId === variant.id)
          .sort((left, right) => left.position - right.position)
          .map((item) => ({
            ...item,
            libraryFile: item.libraryFileId ? { id: item.libraryFileId } : null
          }))
      }))
  })

  const withOrderRelations = (order: OrdersState['orders'][number]) => ({
    ...order,
    selectedVariants: state.orderVariantSelections
      .filter((selection) => selection.orderId === order.id)
      .sort((left, right) => left.position - right.position),
    prints: state.orderPrints
      .filter((print) => print.orderId === order.id)
      .sort((left, right) => {
        if (left.groupPosition !== right.groupPosition) return left.groupPosition - right.groupPosition
        return left.sequenceNumber - right.sequenceNumber
      })
      .map((print) => ({
        ...print,
        libraryFile: print.libraryFileId ? { id: print.libraryFileId } : null,
        startedPrinter: print.startedPrinterId
          ? state.printers.find((printer) => printer.id === print.startedPrinterId) ?? null
          : null
      }))
  })

  const prisma = {
    async $transaction<T>(callback: (tx: unknown) => Promise<T>): Promise<T> {
      return callback(prisma)
    },
    libraryFile: {
      async findUnique({ where, select }: { where: { id: string }; select?: Record<string, boolean> }) {
        const file = state.libraryFiles.find((row) => row.id === where.id) ?? null
        if (!file || !select) return file
        return Object.fromEntries(Object.entries(select).map(([key]) => [key, file[key as keyof typeof file]]))
      }
    },
    orderTemplate: {
      async findMany() {
        return state.orderTemplates
          .slice()
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
          .map(withTemplateRelations)
      },
      async findUnique({ where, include }: { where: { id: string }; include?: unknown }) {
        const template = state.orderTemplates.find((row) => row.id === where.id) ?? null
        if (!template || !include) return template
        return withTemplateRelations(template)
      },
      async create({ data, include }: { data: Record<string, unknown>; include?: unknown }) {
        const timestamp = now()
        const template = {
          id: nextId('template'),
          name: String(data.name),
          code: (data.code as string | null | undefined) ?? null,
          description: (data.description as string | null | undefined) ?? null,
          notesTemplate: (data.notesTemplate as string | null | undefined) ?? null,
          createdAt: timestamp,
          updatedAt: timestamp
        }
        state.orderTemplates.push(template)
        const variants = ((data.variants as { create: Array<Record<string, unknown>> }).create ?? [])
        for (const variant of variants) {
          const variantId = nextId('template-variant')
          state.orderTemplateVariants.push({
            id: variantId,
            templateId: template.id,
            name: String(variant.name),
            position: Number(variant.position),
            createdAt: timestamp,
            updatedAt: timestamp
          })

          const items = ((variant.items as { create: Array<Record<string, unknown>> }).create ?? [])
          for (const item of items) {
            state.orderTemplatePrints.push({
              id: nextId('template-print'),
              templateVariantId: variantId,
              libraryFileId: (item.libraryFileId as string | null | undefined) ?? null,
              libraryFileName: String(item.libraryFileName),
              plate: Number(item.plate),
              quantity: Number(item.quantity),
              notes: (item.notes as string | null | undefined) ?? null,
              position: Number(item.position)
            })
          }
        }
        return include ? withTemplateRelations(template) : template
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        const template = state.orderTemplates.find((row) => row.id === where.id)
        if (!template) return null
        if (data.name !== undefined) template.name = String(data.name)
        if (data.code !== undefined) template.code = (data.code as string | null) ?? null
        if (data.description !== undefined) template.description = (data.description as string | null) ?? null
        if (data.notesTemplate !== undefined) template.notesTemplate = (data.notesTemplate as string | null) ?? null
        const variants = (data.variants as { create: Array<Record<string, unknown>> } | undefined)?.create ?? []
        for (const variant of variants) {
          const variantId = nextId('template-variant')
          state.orderTemplateVariants.push({
            id: variantId,
            templateId: template.id,
            name: String(variant.name),
            position: Number(variant.position),
            createdAt: now(),
            updatedAt: now()
          })

          const items = ((variant.items as { create: Array<Record<string, unknown>> }).create ?? [])
          for (const item of items) {
            state.orderTemplatePrints.push({
              id: nextId('template-print'),
              templateVariantId: variantId,
              libraryFileId: (item.libraryFileId as string | null | undefined) ?? null,
              libraryFileName: String(item.libraryFileName),
              plate: Number(item.plate),
              quantity: Number(item.quantity),
              notes: (item.notes as string | null | undefined) ?? null,
              position: Number(item.position)
            })
          }
        }
        template.updatedAt = now()
        return template
      },
      async delete({ where }: { where: { id: string } }) {
        const variantIds = new Set(
          state.orderTemplateVariants
            .filter((row) => row.templateId === where.id)
            .map((row) => row.id)
        )
        state.orderTemplates = state.orderTemplates.filter((row) => row.id !== where.id)
        state.orderTemplateVariants = state.orderTemplateVariants.filter((row) => row.templateId !== where.id)
        state.orderTemplatePrints = state.orderTemplatePrints.filter((row) => !variantIds.has(row.templateVariantId ?? ''))
      }
    },
    orderTemplateVariant: {
      async deleteMany({ where }: { where: { templateId: string } }) {
        const variantIds = new Set(
          state.orderTemplateVariants
            .filter((row) => row.templateId === where.templateId)
            .map((row) => row.id)
        )
        state.orderTemplateVariants = state.orderTemplateVariants.filter((row) => row.templateId !== where.templateId)
        state.orderTemplatePrints = state.orderTemplatePrints.filter((row) => !variantIds.has(row.templateVariantId ?? ''))
      }
    },
    order: {
      async findMany() {
        return state.orders
          .slice()
          .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      },
      async findUnique({ where, include, select }: { where: { id: string }; include?: unknown; select?: Record<string, boolean> }) {
        const order = state.orders.find((row) => row.id === where.id) ?? null
        if (!order) return null
        if (select) {
          return Object.fromEntries(Object.entries(select).map(([key]) => [key, order[key as keyof typeof order]]))
        }
        if (include) return withOrderRelations(order)
        return order
      },
      async create({ data }: { data: Record<string, unknown> }) {
        const timestamp = now()
        const order = {
          id: nextId('order'),
          templateId: (data.templateId as string | null | undefined) ?? null,
          templateName: String(data.templateName),
          templateCode: (data.templateCode as string | null | undefined) ?? null,
          templateDescription: (data.templateDescription as string | null | undefined) ?? null,
          name: String(data.name),
          notes: (data.notes as string | null | undefined) ?? null,
          status: 'active',
          completedAt: null,
          createdAt: timestamp,
          updatedAt: timestamp
        }
        state.orders.push(order)
        const selectedVariants = ((data.selectedVariants as { create: Array<Record<string, unknown>> }).create ?? [])
        for (const selection of selectedVariants) {
          state.orderVariantSelections.push({
            id: nextId('order-variant-selection'),
            orderId: order.id,
            templateVariantId: (selection.templateVariantId as string | null | undefined) ?? null,
            templateVariantName: String(selection.templateVariantName),
            quantity: Number(selection.quantity),
            position: Number(selection.position),
            createdAt: timestamp,
            updatedAt: timestamp
          })
        }
        const prints = ((data.prints as { create: Array<Record<string, unknown>> }).create ?? [])
        for (const print of prints) {
          state.orderPrints.push({
            id: nextId('order-print'),
            orderId: order.id,
            templatePrintId: (print.templatePrintId as string | null | undefined) ?? null,
            templateVariantId: (print.templateVariantId as string | null | undefined) ?? null,
            templateVariantName: (print.templateVariantName as string | null | undefined) ?? null,
            projectFilamentOverrides: (print.projectFilamentOverrides as OrdersState['orderPrints'][number]['projectFilamentOverrides']) ?? null,
            libraryFileId: (print.libraryFileId as string | null | undefined) ?? null,
            libraryFileName: String(print.libraryFileName),
            plate: Number(print.plate),
            notes: (print.notes as string | null | undefined) ?? null,
            groupPosition: Number(print.groupPosition),
            sequenceNumber: Number(print.sequenceNumber),
            sequenceCount: Number(print.sequenceCount),
            status: 'pending',
            completionSource: null,
            attemptCount: 0,
            startedPrinterId: null,
            startedAt: null,
            lastPrintJobId: null,
            lastPrintResult: null,
            lastPrintFinishedAt: null,
            completedAt: null,
            createdAt: timestamp,
            updatedAt: timestamp
          })
        }
        return order
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        const order = state.orders.find((row) => row.id === where.id)
        if (!order) return null
        if (data.name !== undefined) order.name = String(data.name)
        if (data.notes !== undefined) order.notes = (data.notes as string | null) ?? null
        if (data.status !== undefined) order.status = String(data.status)
        if (data.completedAt !== undefined) order.completedAt = (data.completedAt as Date | null) ?? null
        order.updatedAt = now()
        return order
      },
      async delete({ where }: { where: { id: string } }) {
        state.orders = state.orders.filter((row) => row.id !== where.id)
        state.orderVariantSelections = state.orderVariantSelections.filter((row) => row.orderId !== where.id)
        state.orderPrints = state.orderPrints.filter((row) => row.orderId !== where.id)
      }
    },
    orderPrint: {
      async findMany({ where, select }: { where?: { status?: string }; select?: Record<string, boolean> }) {
        const rows = state.orderPrints.filter((row) => where?.status === undefined || row.status === where.status)
        if (!select) return rows
        return rows.map((row) => Object.fromEntries(Object.entries(select).map(([key]) => [key, row[key as keyof typeof row]])))
      },
      async findUnique({ where }: { where: { id: string } }) {
        return state.orderPrints.find((row) => row.id === where.id) ?? null
      },
      async findFirst({ where }: { where: { id?: string; orderId?: string } }) {
        return state.orderPrints.find((row) => {
          if (where.id !== undefined && row.id !== where.id) return false
          if (where.orderId !== undefined && row.orderId !== where.orderId) return false
          return true
        }) ?? null
      },
      async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        const print = state.orderPrints.find((row) => row.id === where.id)
        if (!print) return null
        for (const [key, value] of Object.entries(data)) {
          if (key === 'attemptCount' && value && typeof value === 'object' && 'increment' in value) {
            print.attemptCount += Number((value as { increment: number }).increment)
            continue
          }
          ;(print as Record<string, unknown>)[key] = value
        }
        print.updatedAt = now()
        return print
      },
      async count({ where }: { where: { orderId: string; status: { not: string } } }) {
        return state.orderPrints.filter((row) => row.orderId === where.orderId && row.status !== where.status.not).length
      }
    },
    printJob: {
      async findFirst({ where }: { where: { printerId: string; fileName: string; plate: number; startedAt: { gte: Date } } }) {
        return state.printJobs
          .filter((job) => job.printerId === where.printerId && job.fileName === where.fileName && job.plate === where.plate && job.startedAt.getTime() >= where.startedAt.gte.getTime())
          .sort((left, right) => right.startedAt.getTime() - left.startedAt.getTime())[0] ?? null
      }
    }
  }

  return prisma
}

async function withRegisteredPluginApp<T>(
  options: {
    plugin: ReturnType<typeof createOrdersPlugin>
    prisma: ReturnType<typeof createPrismaStub>
    wsBroadcast?: (event: unknown) => void
  },
  run: (context: { baseUrl: string }) => Promise<T>
): Promise<T> {
  const originalTenantFindUnique = prisma.tenant.findUnique
  const app = express()
  app.use(express.json())
  prisma.tenant.findUnique = ((async () => ({ id: 'tenant-1', slug: 'test-tenant', name: 'Test Tenant' })) as unknown) as typeof prisma.tenant.findUnique
  app.use((request, _response, next) => {
    request.headers['x-printstream-tenant'] = 'test-tenant'
    next()
  })
  app.use(installTenantContext())
  app.use((request, _response, next) => {
    request.auth = {
      authEnabled: false,
      actor: { type: 'anonymous' },
      permissions: [],
      runtimePolicy: { demoMode: false }
    } satisfies RequestAuthContext
    next()
  })

  const router = express.Router()
  app.use('/api/plugins/orders', router)
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) {
      response.status(error.statusCode).json({ error: error.message })
      return
    }
    response.status(500).json({ error: 'Internal server error' })
  })

  await options.plugin.register({
    pluginName: 'orders',
    logger: { info() {}, warn() {}, error() {} },
    prisma: options.prisma,
    printerEvents: new PrinterEventBus(),
    ws: {
      broadcast(event: unknown) {
        options.wsBroadcast?.(event)
      }
    },
    router,
    settings: {
      async get() { return null },
      async set() {},
      async delete() {}
    },
    onShutdown() {},
    registerPrintGuard() {
      return () => {}
    }
  } as never)

  const server = await new Promise<import('node:http').Server>((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })

  try {
    const address = server.address() as AddressInfo
    return await run({ baseUrl: `http://127.0.0.1:${address.port}` })
  } finally {
    prisma.tenant.findUnique = originalTenantFindUnique
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}