import assert from 'node:assert/strict'
import { test } from 'node:test'
import { collectUploadTreeFromFileList, formatUploadTreeItemPath } from './libraryUploadTree.js'

function makeFile(name: string, relativePath?: string): File {
  const file = new File(['data'], name)
  if (relativePath !== undefined) {
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath })
  }
  return file
}

test('collectUploadTreeFromFileList leaves plain picked files at the destination root', () => {
  const items = collectUploadTreeFromFileList([makeFile('widget.3mf'), makeFile('part.stl')])
  assert.deepEqual(items.map((item) => ({ name: item.file.name, folderSegments: item.folderSegments })), [
    { name: 'widget.3mf', folderSegments: [] },
    { name: 'part.stl', folderSegments: [] }
  ])
})

test('collectUploadTreeFromFileList derives folder chains from webkitRelativePath', () => {
  const items = collectUploadTreeFromFileList([
    makeFile('part.stl', 'Project/Parts/part.stl'),
    makeFile('readme.txt', 'Project/readme.txt')
  ])
  assert.deepEqual(items.map((item) => item.folderSegments), [['Project', 'Parts'], ['Project']])
})

test('collectUploadTreeFromFileList skips OS junk files', () => {
  const items = collectUploadTreeFromFileList([
    makeFile('.DS_Store', 'Project/.DS_Store'),
    makeFile('Thumbs.db'),
    makeFile('._part.stl', 'Project/._part.stl'),
    makeFile('part.stl', 'Project/part.stl')
  ])
  assert.deepEqual(items.map((item) => item.file.name), ['part.stl'])
})

test('formatUploadTreeItemPath joins the folder chain and file name for display', () => {
  assert.equal(
    formatUploadTreeItemPath({ file: makeFile('part.stl'), folderSegments: ['Project', 'Parts'] }),
    'Project/Parts/part.stl'
  )
  assert.equal(formatUploadTreeItemPath({ file: makeFile('part.stl'), folderSegments: [] }), 'part.stl')
})
