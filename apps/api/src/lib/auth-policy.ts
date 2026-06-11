/**
 * Shared auth policy helpers.
 *
 * These settings shape browser-session behavior across every auth provider,
 * so they live in core state instead of any provider-specific plugin scope.
 */
import {
  authSessionDurationPresetSchema,
  authSessionDurationSchema,
  type AuthSessionDuration,
  type AuthSessionDurationPreset
} from '@printstream/shared'
import { scopeSettingKey } from './tenant-settings.js'

interface AuthPolicyStore {
  setting: {
    findUnique(args: { where: { key: string } }): Promise<{ value: string } | null>
    upsert(args: {
      where: { key: string }
      create: { key: string; value: string }
      update: { value: string }
    }): Promise<unknown>
  }
}

export const AUTH_SESSION_DURATION_SETTING_KEY = 'auth:sessionDuration'
export const DEFAULT_AUTH_SESSION_DURATION: AuthSessionDuration = 'day'

const AUTH_SESSION_DURATION_SECONDS: Record<AuthSessionDurationPreset, number> = {
  day: 60 * 60 * 24,
  week: 60 * 60 * 24 * 7,
  month: 60 * 60 * 24 * 30
}

export async function readAuthSessionDuration(prisma: AuthPolicyStore): Promise<AuthSessionDuration> {
  const row = await prisma.setting.findUnique({ where: { key: scopeSettingKey(AUTH_SESSION_DURATION_SETTING_KEY) } })
  const parsed = authSessionDurationSchema.safeParse(row?.value ?? null)
  return parsed.success ? parsed.data : DEFAULT_AUTH_SESSION_DURATION
}

export async function readAuthSessionMaxAgeSeconds(prisma: AuthPolicyStore): Promise<number> {
  const duration = await readAuthSessionDuration(prisma)
  const preset = authSessionDurationPresetSchema.safeParse(duration)
  if (preset.success) {
    return AUTH_SESSION_DURATION_SECONDS[preset.data]
  }

  return parseCustomSessionDurationMinutes(duration) * 60
}

export async function writeAuthSessionDuration(prisma: AuthPolicyStore, sessionDuration: AuthSessionDuration): Promise<void> {
  const key = scopeSettingKey(AUTH_SESSION_DURATION_SETTING_KEY)
  await prisma.setting.upsert({
    where: { key },
    create: {
      key,
      value: sessionDuration
    },
    update: {
      value: sessionDuration
    }
  })
}

function parseCustomSessionDurationMinutes(duration: AuthSessionDuration): number {
  if (!duration.startsWith('custom:')) {
    throw new Error(`Unsupported custom auth session duration: ${duration}`)
  }

  const minutes = Number.parseInt(duration.slice('custom:'.length), 10)
  if (!Number.isInteger(minutes)) {
    throw new Error(`Invalid custom auth session duration: ${duration}`)
  }

  return minutes
}