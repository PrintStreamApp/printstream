/**
 * Public catalogue contract for PrintStream companion app downloads.
 *
 * The catalogue is intentionally deployment-neutral so self-hosted browser
 * clients can consume the hosted release list without importing cloud-only
 * implementation details.
 */
import { z } from 'zod'

/** One store destination or directly downloadable desktop package. */
export const nativeAppDownloadSchema = z.object({
  platformKey: z.string(),
  label: z.string(),
  fileName: z.string().nullable(),
  format: z.string(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  url: z.string().url()
})
export type NativeAppDownload = z.infer<typeof nativeAppDownloadSchema>

export const nativeAppDownloadsResponseSchema = z.object({
  version: z.string().nullable(),
  downloads: z.array(nativeAppDownloadSchema)
})
export type NativeAppDownloadsResponse = z.infer<typeof nativeAppDownloadsResponseSchema>
