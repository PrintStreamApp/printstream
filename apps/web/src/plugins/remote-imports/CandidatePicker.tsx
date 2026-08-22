/**
 * Card grid for choosing which provider file to import.
 *
 * Owns the whole "which file?" surface on the remote-import page — it replaced a
 * `Select` plus a separate review card, so each card carries its own detail and
 * there is nothing to confirm elsewhere. Selection state is not held here: the
 * parent owns `candidateUrl` and the picker reports clicks through `onSelect`.
 *
 * Thumbnails come from the untrusted extension handoff and are already narrowed
 * to https provider hosts by `sanitizeRemoteImportThumbnailUrl` in the shared
 * candidate schema; the image host must also be allowed by the API's `img-src`
 * CSP directive (`apps/api/src/lib/content-security-policy.ts`).
 */
import { useState } from 'react'
import {
  AspectRatio,
  Box,
  Card,
  CardContent,
  CardOverflow,
  Chip,
  Radio,
  RadioGroup,
  Stack,
  Typography
} from '@mui/joy'
import InsertDriveFileRoundedIcon from '@mui/icons-material/InsertDriveFileRounded'
import type { RemoteImportCandidate } from '@printstream/shared'

type CandidatePickerProps = {
  candidates: RemoteImportCandidate[]
  selectedUrl: string
  onSelect: (candidate: RemoteImportCandidate) => void
}

export function CandidatePicker({ candidates, selectedUrl, onSelect }: CandidatePickerProps) {
  return (
    <RadioGroup
      value={selectedUrl || null}
      onChange={(event) => {
        const picked = candidates.find((entry) => entry.sourceUrl === event.target.value)
        if (picked) onSelect(picked)
      }}
      sx={{
        display: 'grid',
        // `min(100%, …)` so a 375px phone shrinks the track instead of forcing a
        // 200px column the card cannot fit and scrolling the page sideways.
        gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))',
        gap: 1.5
      }}
    >
      {candidates.map((candidate) => (
        <CandidateCard
          key={candidate.id}
          candidate={candidate}
          selected={candidate.sourceUrl === selectedUrl}
        />
      ))}
    </RadioGroup>
  )
}

function CandidateCard({
  candidate,
  selected
}: {
  candidate: RemoteImportCandidate
  selected: boolean
}) {
  // A provider URL can 404 after the page was scraped; fall back to the same-size
  // placeholder so the grid never reflows and no broken-image glyph appears.
  const [imageFailed, setImageFailed] = useState(false)
  const thumbnailUrl = imageFailed ? null : candidate.thumbnailUrl

  return (
    <Card
      variant={selected ? 'soft' : 'outlined'}
      color={selected ? 'primary' : 'neutral'}
      sx={{
        gap: 1,
        transition: 'border-color 120ms',
        '&:hover': { borderColor: 'primary.500' }
      }}
    >
      <CardOverflow>
        <AspectRatio ratio="4/3">
          {thumbnailUrl ? (
            <img
              src={thumbnailUrl}
              alt=""
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={() => setImageFailed(true)}
            />
          ) : (
            // Size/opacity live on the Joy Box: an `sx` on a Material icon is
            // resolved against the Joy theme and throws in its breakpoint pass.
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, opacity: 0.6 }}>
              <InsertDriveFileRoundedIcon fontSize="inherit" />
            </Box>
          )}
        </AspectRatio>
      </CardOverflow>

      <CardContent sx={{ gap: 0.75 }}>
        <Radio
          overlay
          value={candidate.sourceUrl}
          label={
            <Typography
              level="title-sm"
              sx={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
            >
              {candidate.name}
            </Typography>
          }
        />
        <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap' }}>
          <Chip size="sm" variant="soft">{candidate.fileType}</Chip>
          <Chip size="sm" variant="soft" color={candidate.printableStatus === 'printer-ready' ? 'success' : 'neutral'}>
            {candidate.printableStatus === 'printer-ready' ? 'printer-ready' : 'import only'}
          </Chip>
        </Stack>
        <Typography level="body-xs">{candidate.recommendationReason}</Typography>
      </CardContent>
    </Card>
  )
}
