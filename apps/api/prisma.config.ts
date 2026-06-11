import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'
import { defineConfig, env } from 'prisma/config'

const currentDir = dirname(fileURLToPath(import.meta.url))
const repoRootEnvPath = resolve(currentDir, '../../.env')

loadEnv({ path: repoRootEnvPath })
loadEnv()

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations'
  },
  datasource: {
    url: env('DATABASE_URL')
  }
})