/**
 * Pure 3MF transforms for BambuStudio-compatible project Auxiliaries.
 *
 * ZIP I/O stays in each host. This module owns the archive paths, root-model metadata and package
 * thumbnail relationships so browser and API bakes cannot produce different projects.
 */
import {
  PROJECT_AUXILIARY_CATEGORIES,
  decodeProjectAuxiliaryBase64,
  type ProjectAuxiliaries,
  type ProjectAuxiliaryCategory
} from '../project-auxiliaries.js'
import { decodeXmlAttributeValue, escapeRegExp, escapeXmlAttribute } from './xml-write.js'

export const PROJECT_AUXILIARY_ROOT = 'Auxiliaries/'
export const PROJECT_AUXILIARY_THUMBNAIL_ROOT = `${PROJECT_AUXILIARY_ROOT}.thumbnails/`

const METADATA_KEYS = {
  modelName: 'Title',
  modelAuthor: 'Designer',
  modelDescription: 'Description',
  modelId: 'model_id',
  profileName: 'ProfileTitle',
  profileAuthor: 'ProfileUserName',
  profileDescription: 'ProfileDescription'
} as const

/** The managed folder prefix used for one attachment category. */
export function projectAuxiliaryCategoryPrefix(category: ProjectAuxiliaryCategory): string {
  return `${PROJECT_AUXILIARY_ROOT}${category}/`
}

/** Prefixes replaced as complete state when an edit carries project auxiliaries. */
export function managedProjectAuxiliaryPrefixes(): string[] {
  return [
    ...PROJECT_AUXILIARY_CATEGORIES.map(projectAuxiliaryCategoryPrefix),
    PROJECT_AUXILIARY_THUMBNAIL_ROOT
  ]
}

/** Binary archive entries represented by an edit's complete attachment state. */
export function projectAuxiliaryArchiveEntries(auxiliaries: ProjectAuxiliaries): Array<{ name: string; content: Uint8Array }> {
  const files = auxiliaries.files.map((file) => ({
    name: `${projectAuxiliaryCategoryPrefix(file.category)}${file.name}`,
    content: decodeProjectAuxiliaryBase64(file.contentBase64)
  }))
  if (!auxiliaries.coverThumbnails) return files
  return [
    ...files,
    { name: `${PROJECT_AUXILIARY_THUMBNAIL_ROOT}thumbnail_3mf.png`, content: decodeProjectAuxiliaryBase64(auxiliaries.coverThumbnails.threeMf) },
    { name: `${PROJECT_AUXILIARY_THUMBNAIL_ROOT}thumbnail_small.png`, content: decodeProjectAuxiliaryBase64(auxiliaries.coverThumbnails.small) },
    { name: `${PROJECT_AUXILIARY_THUMBNAIL_ROOT}thumbnail_middle.png`, content: decodeProjectAuxiliaryBase64(auxiliaries.coverThumbnails.middle) }
  ]
}

/** Apply project metadata and picture-cover names to the root 3MF model document. */
export function applyProjectAuxiliaryMetadata(modelXml: string, auxiliaries: ProjectAuxiliaries): string {
  const modelCover = auxiliaries.files.find((file) => file.category === 'Model Pictures' && file.cover)?.name ?? ''
  const profileCover = auxiliaries.files.find((file) => file.category === 'Profile Pictures' && file.cover)?.name ?? ''
  const values: Record<string, string> = {
    ...Object.fromEntries(Object.entries(METADATA_KEYS).map(([field, key]) => [key, auxiliaries.metadata[field as keyof typeof METADATA_KEYS]])),
    DesignerCover: modelCover,
    ProfileCover: profileCover
  }
  return Object.entries(values).reduce((xml, [key, value]) => upsertRootMetadata(xml, key, value), modelXml)
}

/** Read the metadata surface the Auxiliaries dialog owns from a root model document. */
export function readProjectAuxiliaryMetadata(modelXml: string): ProjectAuxiliaries['metadata'] {
  const read = (key: string): string => {
    const match = new RegExp(`<metadata\\b[^>]*\\bname="${escapeRegExp(key)}"[^>]*>([\\s\\S]*?)<\\/metadata>`, 'i').exec(modelXml)
    return match ? decodeXmlAttributeValue(match[1] ?? '') : ''
  }
  return {
    modelName: read(METADATA_KEYS.modelName),
    modelAuthor: read(METADATA_KEYS.modelAuthor),
    modelDescription: read(METADATA_KEYS.modelDescription),
    modelId: read(METADATA_KEYS.modelId),
    profileName: read(METADATA_KEYS.profileName),
    profileAuthor: read(METADATA_KEYS.profileAuthor),
    profileDescription: read(METADATA_KEYS.profileDescription)
  }
}

/** Cover names stored by BambuStudio in root-model metadata. */
export function readProjectAuxiliaryCoverNames(modelXml: string): { model: string; profile: string } {
  const read = (key: string): string => {
    const match = new RegExp(`<metadata\\b[^>]*\\bname="${key}"[^>]*>([\\s\\S]*?)<\\/metadata>`, 'i').exec(modelXml)
    return match ? decodeXmlAttributeValue(match[1] ?? '') : ''
  }
  return { model: read('DesignerCover'), profile: read('ProfileCover') }
}

/** Point the package cover relationships at generated auxiliary thumbnails, or back at plate 1. */
export function applyProjectAuxiliaryRelationships(relsXml: string, hasModelCover: boolean): string {
  const targets = hasModelCover
    ? {
        'rel-2': `/${PROJECT_AUXILIARY_THUMBNAIL_ROOT}thumbnail_3mf.png`,
        'rel-4': `/${PROJECT_AUXILIARY_THUMBNAIL_ROOT}thumbnail_middle.png`,
        'rel-5': `/${PROJECT_AUXILIARY_THUMBNAIL_ROOT}thumbnail_small.png`
      }
    : {
        'rel-2': '/Metadata/plate_1.png',
        'rel-4': '/Metadata/plate_1.png',
        'rel-5': '/Metadata/plate_1_small.png'
      }
  return Object.entries(targets).reduce((xml, [id, target]) => {
    const relationship = new RegExp(`(<Relationship\\b[^>]*\\bId="${id}"[^>]*\\bTarget=")[^"]*(")`, 'i')
    const targetFirst = new RegExp(`(<Relationship\\b[^>]*\\bTarget=")[^"]*("[^>]*\\bId="${id}"[^>]*>)`, 'i')
    if (relationship.test(xml)) return xml.replace(relationship, `$1${target}$2`)
    if (targetFirst.test(xml)) return xml.replace(targetFirst, `$1${target}$2`)
    return xml
  }, relsXml)
}

function upsertRootMetadata(modelXml: string, name: string, value: string): string {
  const encoded = escapeXmlAttribute(value)
  const pattern = new RegExp(`<metadata\\b[^>]*\\bname="${escapeRegExp(name)}"[^>]*>[\\s\\S]*?<\\/metadata>`, 'i')
  const element = `<metadata name="${name}">${encoded}</metadata>`
  if (pattern.test(modelXml)) return modelXml.replace(pattern, element)
  return modelXml.replace(/(<model\b[^>]*>)/i, `$1\n  ${element}`)
}
