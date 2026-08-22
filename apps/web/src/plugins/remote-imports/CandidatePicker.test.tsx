/* CandidatePicker tests: one card per candidate, clicking a card selects it, and a
 * candidate with no provider cover falls back to an icon instead of a broken image. */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { CssVarsProvider } from '@mui/joy/styles'
import { cleanup, render } from '@testing-library/react'
import React from 'react'
import type { RemoteImportCandidate } from '@printstream/shared'
import { installJsdomGlobals } from '../../test-utils/jsdom'
import { CandidatePicker } from './CandidatePicker'

installJsdomGlobals({ url: 'http://localhost/workspaces/alpha/import' })

afterEach(() => {
  cleanup()
})

function candidate(overrides: Partial<RemoteImportCandidate>): RemoteImportCandidate {
  return {
    id: 'candidate',
    provider: 'makerworld',
    sourceUrl: 'https://makerworld.com/en/models/1#profileId-1',
    name: 'Model.3mf',
    sizeBytes: null,
    fileType: '3mf',
    printableStatus: 'unknown',
    confidence: 0.9,
    recommendationReason: 'Import to the library.',
    thumbnailUrl: null,
    ...overrides
  }
}

function renderPicker(
  candidates: RemoteImportCandidate[],
  selectedUrl: string,
  onSelect: (candidate: RemoteImportCandidate) => void = () => {}
) {
  return render(
    <CssVarsProvider>
      <CandidatePicker candidates={candidates} selectedUrl={selectedUrl} onSelect={onSelect} />
    </CssVarsProvider>
  )
}

test('renders one selectable card per candidate with its cover', () => {
  const withCover = candidate({ id: 'a', thumbnailUrl: 'https://public-cdn.bblmw.com/a.png' })
  const withoutCover = candidate({
    id: 'b',
    name: 'Other.3mf',
    sourceUrl: 'https://makerworld.com/en/models/1#profileId-2'
  })

  const { container, getByText } = renderPicker([withCover, withoutCover], withCover.sourceUrl)

  getByText('Model.3mf')
  getByText('Other.3mf')
  const images = container.querySelectorAll('img')
  assert.equal(images.length, 1, 'only the candidate with a cover renders an <img>')
  assert.equal(images[0]?.getAttribute('src'), 'https://public-cdn.bblmw.com/a.png')
  assert.equal(container.querySelectorAll('input[type="radio"]').length, 2)
})

test('clicking a card reports that candidate', () => {
  const first = candidate({ id: 'a' })
  const second = candidate({
    id: 'b',
    name: 'Other.3mf',
    sourceUrl: 'https://makerworld.com/en/models/1#profileId-2'
  })
  const selected: RemoteImportCandidate[] = []

  const { container } = renderPicker([first, second], first.sourceUrl, (picked) => selected.push(picked))

  const radios = container.querySelectorAll<HTMLInputElement>('input[type="radio"]')
  radios[1]?.click()

  assert.deepEqual(selected.map((entry) => entry.id), ['b'])
})
