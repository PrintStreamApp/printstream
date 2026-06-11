import path from 'node:path'
import { fileURLToPath } from 'node:url'
import dotenv from 'dotenv'
import { PrismaClient } from '@prisma/client'
import { resetAuthData } from '../../src/lib/auth-reset.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
dotenv.config({ path: path.join(repoRoot, '.env') })

const prisma = new PrismaClient()

try {
  console.log(JSON.stringify(await resetAuthData(prisma), null, 2))
} finally {
  await prisma.$disconnect()
}