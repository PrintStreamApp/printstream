/**
 * Read the project settings embedded in a slicer input 3MF.
 *
 * A missing entry is valid for scaffold inputs. Malformed JSON and ZIP failures remain errors,
 * so callers can distinguish an absent project config from corrupt input.
 */
import { parseProjectSettings } from './output-metadata.js'
import { readZipEntryText } from './zip-io.js'

const PROJECT_SETTINGS_ENTRY = 'Metadata/project_settings.config'

/** Return embedded settings, null for a missing entry, or reject invalid content. */
export async function readThreeMfProjectSettings(inputPath: string): Promise<Record<string, unknown> | null> {
  let text: string
  try {
    text = await readZipEntryText(inputPath, PROJECT_SETTINGS_ENTRY)
  } catch (error) {
    if ((error as Error).message === `Entry not found: ${PROJECT_SETTINGS_ENTRY}`) return null
    throw error
  }
  return parseProjectSettings(Buffer.from(text, 'utf8'))
}
