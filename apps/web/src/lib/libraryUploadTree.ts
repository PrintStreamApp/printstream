/**
 * Collects files (with their relative folder paths) for library uploads that
 * replicate a folder structure: a `webkitdirectory` picker's FileList, or a
 * drag-and-drop of mixed files and folders traversed via the FileSystemEntry
 * API. OS junk files (.DS_Store, Thumbs.db, AppleDouble "._*") are skipped.
 */

export interface LibraryUploadTreeItem {
  file: File
  /** Folder chain, relative to the upload destination, the file belongs in. */
  folderSegments: string[]
}

const JUNK_FILE_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini'])

function isJunkFile(name: string): boolean {
  const lower = name.toLowerCase()
  return JUNK_FILE_NAMES.has(lower) || lower.startsWith('._')
}

/** Display path ("Folder/Sub/file.stl") for progress and error messages. */
export function formatUploadTreeItemPath(item: LibraryUploadTreeItem): string {
  return [...item.folderSegments, item.file.name].join('/')
}

/**
 * Build upload items from a file input's FileList. Plain `multiple` pickers
 * yield empty folder chains; `webkitdirectory` pickers carry each file's
 * `webkitRelativePath`, which becomes the folder chain.
 */
export function collectUploadTreeFromFileList(files: ArrayLike<File>): LibraryUploadTreeItem[] {
  const items: LibraryUploadTreeItem[] = []
  for (const file of Array.from(files)) {
    if (isJunkFile(file.name)) continue
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath ?? ''
    const folderSegments = relativePath ? relativePath.split('/').slice(0, -1).filter(Boolean) : []
    items.push({ file, folderSegments })
  }
  return items
}

/**
 * Build upload items from a drop's DataTransfer, recursing into dropped
 * directories. Entries are captured synchronously (they become unreadable once
 * the handler yields) and traversed asynchronously afterwards. Falls back to
 * the flat file list when the entries API is unavailable.
 */
export async function collectUploadTreeFromDataTransfer(dataTransfer: DataTransfer): Promise<LibraryUploadTreeItem[]> {
  const entries: FileSystemEntry[] = []
  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    if (entry) entries.push(entry)
  }
  if (entries.length === 0) return collectUploadTreeFromFileList(dataTransfer.files)
  const items: LibraryUploadTreeItem[] = []
  for (const entry of entries) {
    await collectEntry(entry, [], items)
  }
  return items
}

async function collectEntry(entry: FileSystemEntry, folderSegments: string[], out: LibraryUploadTreeItem[]): Promise<void> {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => {
      (entry as FileSystemFileEntry).file(resolve, reject)
    })
    if (!isJunkFile(file.name)) out.push({ file, folderSegments })
    return
  }
  if (entry.isDirectory) {
    const reader = (entry as FileSystemDirectoryEntry).createReader()
    const childSegments = [...folderSegments, entry.name]
    // readEntries returns results in batches (Chrome caps each at 100); keep
    // reading until an empty batch signals the end of the directory.
    for (;;) {
      const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
        reader.readEntries(resolve, reject)
      })
      if (batch.length === 0) break
      for (const child of batch) {
        await collectEntry(child, childSegments, out)
      }
    }
  }
}
