/** Browser-side loading and image preparation for 3MF project Auxiliaries. */
import {
  PROJECT_AUXILIARY_CATEGORIES,
  MAX_PROJECT_AUXILIARY_FILE_BYTES,
  encodeProjectAuxiliaryBase64,
  projectAuxiliaryFileNameAllowed,
  type ProjectAuxiliaries,
  type ProjectAuxiliaryCategory,
  type ProjectAuxiliaryFile
} from '@printstream/shared'
import {
  PROJECT_AUXILIARY_THUMBNAIL_ROOT,
  projectAuxiliaryCategoryPrefix,
  readProjectAuxiliaryCoverNames,
  readProjectAuxiliaryMetadata
} from '@printstream/shared/three-mf'
import type { ThreeMfArchive } from './threeMfArchive'

const ROOT_MODEL_ENTRY = '3D/3dmodel.model'

/** Read every managed auxiliary entry without dropping unfamiliar extensions from an existing file. */
export function readProjectAuxiliariesFromArchive(archive: ThreeMfArchive): ProjectAuxiliaries {
  const rootModelXml = archive.entryText(ROOT_MODEL_ENTRY) ?? ''
  const covers = readProjectAuxiliaryCoverNames(rootModelXml)
  const files: ProjectAuxiliaryFile[] = []

  for (const category of PROJECT_AUXILIARY_CATEGORIES) {
    const prefix = projectAuxiliaryCategoryPrefix(category)
    for (const entryPath of archive.entryNames()) {
      if (!entryPath.toLowerCase().startsWith(prefix.toLowerCase())) continue
      const name = entryPath.slice(prefix.length)
      if (!name || name.includes('/')) continue
      const bytes = archive.entryBytes(entryPath)
      if (!bytes) continue
      const coverName = category === 'Model Pictures'
        ? covers.model
        : category === 'Profile Pictures' ? covers.profile : ''
      files.push({
        category,
        name,
        contentBase64: encodeProjectAuxiliaryBase64(bytes),
        ...(coverName === name ? { cover: true } : {})
      })
    }
  }

  const thumbnail = (name: string): string | null => {
    const bytes = archive.entryBytes(`${PROJECT_AUXILIARY_THUMBNAIL_ROOT}${name}`)
    return bytes ? encodeProjectAuxiliaryBase64(bytes) : null
  }
  const threeMf = thumbnail('thumbnail_3mf.png')
  const small = thumbnail('thumbnail_small.png')
  const middle = thumbnail('thumbnail_middle.png')

  return {
    files,
    metadata: readProjectAuxiliaryMetadata(rootModelXml),
    ...(threeMf && small && middle ? { coverThumbnails: { threeMf, small, middle } } : {})
  }
}

/** Turn a picked file into one complete-state attachment after checking its category contract. */
export async function projectAuxiliaryFileFromFile(
  category: ProjectAuxiliaryCategory,
  file: File
): Promise<ProjectAuxiliaryFile> {
  if (!projectAuxiliaryFileNameAllowed(category, file.name)) {
    throw new Error(`${file.name} is not a supported ${category.toLowerCase()} file.`)
  }
  if (file.size > MAX_PROJECT_AUXILIARY_FILE_BYTES) {
    throw new Error(`${file.name} is larger than the 16 MB attachment limit.`)
  }
  return {
    category,
    name: file.name,
    contentBase64: encodeProjectAuxiliaryBase64(new Uint8Array(await file.arrayBuffer()))
  }
}

/** Generate BambuStudio's three cover sizes, fitting without cropping onto a transparent canvas. */
export async function generateProjectCoverThumbnails(file: File): Promise<NonNullable<ProjectAuxiliaries['coverThumbnails']>> {
  const bitmap = await createImageBitmap(file)
  try {
    const render = async (width: number, height: number): Promise<string> => {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('This browser cannot prepare project cover images.')
      const scale = Math.min(width / bitmap.width, height / bitmap.height)
      const drawWidth = bitmap.width * scale
      const drawHeight = bitmap.height * scale
      context.drawImage(bitmap, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
      if (!blob) throw new Error('The project cover could not be encoded as PNG.')
      return encodeProjectAuxiliaryBase64(new Uint8Array(await blob.arrayBuffer()))
    }
    const [threeMf, small, middle] = await Promise.all([
      render(240, 240),
      render(252, 188),
      render(680, 680)
    ])
    return { threeMf, small, middle }
  } finally {
    bitmap.close()
  }
}

/** Clone mutable arrays/records for an undo snapshot or dialog draft. */
export function cloneProjectAuxiliaries(auxiliaries: ProjectAuxiliaries): ProjectAuxiliaries {
  return {
    files: auxiliaries.files.map((file) => ({ ...file })),
    metadata: { ...auxiliaries.metadata },
    ...(auxiliaries.coverThumbnails ? { coverThumbnails: { ...auxiliaries.coverThumbnails } } : {})
  }
}
