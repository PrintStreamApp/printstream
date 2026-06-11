import { cp, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { PrismaClient } from '@prisma/client'
import { PUBLIC_DEMO_TENANT_SLUG } from '@printstream/shared'
import { reconcileDemoLibrary, seedDemoJobs } from '../../src/lib/demo/demo-data.js'
import { DEMO_PRINTER_SEEDS } from '../../src/lib/demo/demo-printers.js'
import { ensureBuiltInAuthGroups } from '../../src/lib/default-auth-groups.js'
import { hashBridgeRuntimeToken } from '../../src/lib/bridge-runtime-auth.js'
import { serializePrinterNozzleDiameters } from '../../src/lib/printer-record.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
dotenv.config({ path: path.join(repoRoot, '.env') })

const DEMO_TENANT_NAME = process.env.PUBLIC_DEMO_TENANT_NAME?.trim() || 'PrintStream Demo'
const DEMO_BRIDGE_ID = process.env.PUBLIC_DEMO_BRIDGE_ID?.trim() || 'demo-simulator-bridge'
const DEMO_BRIDGE_NAME = process.env.PUBLIC_DEMO_BRIDGE_NAME?.trim() || 'PrintStream Demo Bridge'
const configuredRuntimeToken = process.env.PUBLIC_DEMO_BRIDGE_RUNTIME_TOKEN?.trim()
if (!configuredRuntimeToken && process.env.NODE_ENV === 'production') {
  throw new Error('PUBLIC_DEMO_BRIDGE_RUNTIME_TOKEN is required when bootstrapping the public demo in production.')
}
const DEMO_BRIDGE_RUNTIME_TOKEN = configuredRuntimeToken || 'demo-simulator-runtime-token'
const DEMO_BRIDGE_STATE_FILE = resolveRepoRelativePath(process.env.PUBLIC_DEMO_BRIDGE_STATE_FILE?.trim() || './data/demo-bridge-state.json')
const DEMO_BRIDGE_LIBRARY_DIR = resolveRepoRelativePath(process.env.PUBLIC_DEMO_BRIDGE_LIBRARY_DIR?.trim() || './data/demo-library')
const DEMO_DATA_ROOT = path.dirname(DEMO_BRIDGE_LIBRARY_DIR)

const prisma = new PrismaClient()

try {
  const result = await bootstrapPublicDemoTenant(prisma)
  console.log(JSON.stringify(result, null, 2))
} finally {
  await prisma.$disconnect()
}

async function bootstrapPublicDemoTenant(prismaClient: PrismaClient): Promise<{
  tenant: { id: string; slug: string; name: string }
  bridge: { id: string; name: string }
  printerCount: number
  libraryFileCount: number
  jobCount: number
  bridgeStateFile: string
  bridgeLibraryDir: string
}> {
  const tenant = await prismaClient.tenant.upsert({
    where: { slug: PUBLIC_DEMO_TENANT_SLUG },
    update: {
      name: DEMO_TENANT_NAME,
      description: 'Public demo workspace backed by the simulator bridge.'
    },
    create: {
      slug: PUBLIC_DEMO_TENANT_SLUG,
      name: DEMO_TENANT_NAME,
      description: 'Public demo workspace backed by the simulator bridge.'
    },
    select: { id: true, slug: true, name: true }
  })

  await ensureBuiltInAuthGroups(prismaClient, tenant.id)

  const bridge = await prismaClient.bridge.upsert({
    where: { id: DEMO_BRIDGE_ID },
    update: {
      tenantId: tenant.id,
      name: DEMO_BRIDGE_NAME,
      connectCode: null,
      runtimeTokenHash: hashBridgeRuntimeToken(DEMO_BRIDGE_RUNTIME_TOKEN),
      version: 'demo-simulator'
    },
    create: {
      id: DEMO_BRIDGE_ID,
      tenantId: tenant.id,
      name: DEMO_BRIDGE_NAME,
      connectCode: null,
      runtimeTokenHash: hashBridgeRuntimeToken(DEMO_BRIDGE_RUNTIME_TOKEN),
      version: 'demo-simulator'
    },
    select: { id: true, name: true }
  })

  for (const seed of DEMO_PRINTER_SEEDS) {
    await prismaClient.printer.upsert({
      where: {
        tenantId_serial: {
          tenantId: tenant.id,
          serial: seed.serial
        }
      },
      update: {
        bridgeId: bridge.id,
        name: seed.name,
        host: seed.host,
        accessCode: seed.accessCode,
        model: seed.model,
        currentPlateType: seed.currentPlateType,
        currentNozzleDiameters: serializePrinterNozzleDiameters(seed.currentNozzleDiameters),
        position: seed.position
      },
      create: {
        tenantId: tenant.id,
        bridgeId: bridge.id,
        name: seed.name,
        host: seed.host,
        serial: seed.serial,
        accessCode: seed.accessCode,
        model: seed.model,
        currentPlateType: seed.currentPlateType,
        currentNozzleDiameters: serializePrinterNozzleDiameters(seed.currentNozzleDiameters),
        position: seed.position
      }
    })
  }

  await syncBundledDemoAssets()
  await reconcileDemoLibrary({ tenantId: tenant.id, bridgeId: bridge.id })
  await seedDemoJobs({ tenantId: tenant.id })
  await mkdir(DEMO_BRIDGE_LIBRARY_DIR, { recursive: true })

  const [libraryFileCount, jobCount] = await Promise.all([
    prismaClient.libraryFile.count({ where: { tenantId: tenant.id, hidden: false } }),
    prismaClient.printJob.count({ where: { tenantId: tenant.id } })
  ])

  await writeBridgeRuntimeState(DEMO_BRIDGE_STATE_FILE, {
    bridgeId: bridge.id,
    runtimeToken: DEMO_BRIDGE_RUNTIME_TOKEN
  })

  return {
    tenant,
    bridge,
    printerCount: DEMO_PRINTER_SEEDS.length,
    libraryFileCount,
    jobCount,
    bridgeStateFile: DEMO_BRIDGE_STATE_FILE,
    bridgeLibraryDir: DEMO_BRIDGE_LIBRARY_DIR
  }
}

async function writeBridgeRuntimeState(filePath: string, state: { bridgeId: string; runtimeToken: string }): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

function resolveRepoRelativePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value)
}

async function syncBundledDemoAssets(): Promise<void> {
  await Promise.all([
    copyBundledDemoPath('data/demo-library', DEMO_BRIDGE_LIBRARY_DIR),
    copyBundledDemoPath('data/demo-camera-snapshots', path.join(DEMO_DATA_ROOT, 'demo-camera-snapshots')),
    copyBundledDemoPath('data/demo-captures', path.join(DEMO_DATA_ROOT, 'demo-captures'))
  ])
}

async function copyBundledDemoPath(sourceRelativePath: string, targetPath: string): Promise<void> {
  const sourcePath = path.join(repoRoot, sourceRelativePath)
  await mkdir(path.dirname(targetPath), { recursive: true })
  await cp(sourcePath, targetPath, {
    force: true,
    recursive: true
  }).catch(() => undefined)
}