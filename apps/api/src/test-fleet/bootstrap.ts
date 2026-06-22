/**
 * Bootstrap the dev-only test fleet: a separate "test" tenant + simulator bridge
 * + one printer per card-state scenario (see @printstream/shared test-fleet). Run
 * via `npm run test-fleet:bootstrap`; pairs with `npm run dev:test-fleet`, which
 * launches the simulator bridge that emits each printer's pinned state. Idempotent
 * (upserts), and writes the bridge's runtime-state file so it can authenticate.
 *
 * Dev tooling — never run as part of normal dev/prod startup.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { PrismaClient } from '@prisma/client'
import {
  TEST_FLEET_BRIDGE_ID,
  TEST_FLEET_BRIDGE_NAME,
  TEST_FLEET_SEEDS,
  TEST_FLEET_TENANT_NAME,
  TEST_FLEET_TENANT_SLUG
} from '@printstream/shared'
import { ensureBuiltInAuthGroups } from '../lib/default-auth-groups.js'
import { hashBridgeRuntimeToken } from '../lib/bridge-runtime-auth.js'
import { serializePrinterNozzleDiameters } from '../lib/printer-record.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
dotenv.config({ path: path.join(repoRoot, '.env') })

const TEST_FLEET_BRIDGE_RUNTIME_TOKEN = process.env.TEST_FLEET_BRIDGE_RUNTIME_TOKEN?.trim() || 'test-fleet-runtime-token'
const TEST_FLEET_BRIDGE_STATE_FILE = resolveRepoRelativePath(
  process.env.TEST_FLEET_BRIDGE_STATE_FILE?.trim() || './data/test-fleet-bridge-state.json'
)

const prisma = new PrismaClient()

try {
  const result = await bootstrapTestFleet(prisma)
  console.log(JSON.stringify(result, null, 2))
} finally {
  await prisma.$disconnect()
}

async function bootstrapTestFleet(prismaClient: PrismaClient): Promise<{
  tenant: { id: string; slug: string; name: string }
  bridge: { id: string; name: string }
  printerCount: number
  bridgeStateFile: string
}> {
  const tenant = await prismaClient.tenant.upsert({
    where: { slug: TEST_FLEET_TENANT_SLUG },
    update: { name: TEST_FLEET_TENANT_NAME, description: 'Dev-only test fleet covering the printer-card state matrix.' },
    create: { slug: TEST_FLEET_TENANT_SLUG, name: TEST_FLEET_TENANT_NAME, description: 'Dev-only test fleet covering the printer-card state matrix.' },
    select: { id: true, slug: true, name: true }
  })

  await ensureBuiltInAuthGroups(prismaClient, tenant.id)

  const bridge = await prismaClient.bridge.upsert({
    where: { id: TEST_FLEET_BRIDGE_ID },
    update: {
      tenantId: tenant.id,
      name: TEST_FLEET_BRIDGE_NAME,
      connectCode: null,
      runtimeTokenHash: hashBridgeRuntimeToken(TEST_FLEET_BRIDGE_RUNTIME_TOKEN),
      version: 'test-fleet-simulator'
    },
    create: {
      id: TEST_FLEET_BRIDGE_ID,
      tenantId: tenant.id,
      name: TEST_FLEET_BRIDGE_NAME,
      connectCode: null,
      runtimeTokenHash: hashBridgeRuntimeToken(TEST_FLEET_BRIDGE_RUNTIME_TOKEN),
      version: 'test-fleet-simulator'
    },
    select: { id: true, name: true }
  })

  for (const seed of TEST_FLEET_SEEDS) {
    const data = {
      bridgeId: bridge.id,
      name: seed.name,
      host: seed.host,
      accessCode: seed.accessCode,
      model: seed.model,
      currentPlateType: seed.currentPlateType,
      currentNozzleDiameters: serializePrinterNozzleDiameters(seed.currentNozzleDiameters),
      position: seed.position
    }
    await prismaClient.printer.upsert({
      where: { tenantId_serial: { tenantId: tenant.id, serial: seed.serial } },
      update: data,
      create: { tenantId: tenant.id, serial: seed.serial, ...data }
    })
  }

  await writeBridgeRuntimeState(TEST_FLEET_BRIDGE_STATE_FILE, {
    bridgeId: bridge.id,
    runtimeToken: TEST_FLEET_BRIDGE_RUNTIME_TOKEN
  })

  return { tenant, bridge, printerCount: TEST_FLEET_SEEDS.length, bridgeStateFile: TEST_FLEET_BRIDGE_STATE_FILE }
}

async function writeBridgeRuntimeState(filePath: string, state: { bridgeId: string; runtimeToken: string }): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
}

function resolveRepoRelativePath(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value)
}
